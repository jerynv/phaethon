//! Canvas grades against a local fake site, with replies shaped like the
//! Canvas REST API docs' examples (enrollments, submissions, assignment groups).

use super::*;
use crate::lms::fake::{self, Reply, json, redirect, status};
use crate::lms::{Cookie, Kind, Site};
use std::sync::Arc;

fn session(base: &str) -> Session {
    let cookies = vec![Cookie { name: "_normandy_session".into(), value: "sess123".into() }];
    Session::new(Site::for_test(Kind::Canvas, base), Credential { cookies, csrf: Some("tok".into()) })
}

fn fx(name: &str) -> String {
    match name {
        "enrollments" => include_str!("../../../tests/fixtures/canvas/grades_enrollments.json"),
        "groups" => include_str!("../../../tests/fixtures/canvas/grades_groups.json"),
        "submissions" => include_str!("../../../tests/fixtures/canvas/grades_submissions.json"),
        _ => unreachable!(),
    }
    .to_string()
}

fn path(target: &str) -> String {
    target.split('?').next().unwrap_or("").to_string()
}

fn site(weighted: bool) -> fake::Route {
    Arc::new(move |t: &str| match path(t).as_str() {
        "/api/v1/courses/1001/enrollments" if t.contains("user_id=self") => json(fx("enrollments")),
        "/api/v1/courses/1001" => json(format!(r#"{{"id":1001,"name":"Discrete","apply_assignment_group_weights":{weighted}}}"#)),
        "/api/v1/courses/1001/assignment_groups" => json(fx("groups")),
        "/api/v1/courses/1001/students/submissions" if t.contains("student_ids%5B%5D=self") => json(format!("while(1);{}", fx("submissions"))),
        "/api/v1/users/self" => json(r#"{"id":42}"#),
        _ => status(404),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn current_and_final_weights_and_flags() {
    let (base, log) = fake::serve(site(true)).await;
    let g = grades(&session(&base), "1001").await.unwrap();

    assert_eq!(g.current.percent, Some(88.42));
    assert_eq!(g.current.letter.as_deref(), Some("B+"));
    assert_eq!(g.current.points, Some(168.0));
    assert_eq!(g.current.possible, None, "a weighted course isn't plain points");
    let fin = g.final_grade.as_ref().expect("final differs from current");
    assert_eq!((fin.percent, fin.letter.as_deref()), (Some(74.1), Some("C")));
    assert_eq!(g.groups, vec![GradeGroup { name: "Homework".into(), weight: Some(40.0) }, GradeGroup { name: "Exams".into(), weight: Some(60.0) }]);
    assert_eq!(g.note, None);

    let by = |t: &str| g.items.iter().find(|i| i.title == t).unwrap_or_else(|| panic!("{t}"));
    let h1 = by("Homework 1");
    assert_eq!((h1.score, h1.possible, h1.percent), (Some(9.0), Some(10.0), Some(90.0)));
    assert!(h1.graded && h1.submitted && !h1.late && !h1.missing);
    assert_eq!(h1.group.as_deref(), Some("Homework"));
    assert_eq!(h1.comments, vec!["Nice proof. Watch the base case."]);
    assert!(by("Homework 2").late);
    let h3 = by("Homework 3");
    assert!(h3.missing && !h3.submitted && h3.score == Some(0.0));
    let h4 = by("Homework 4");
    assert!(h4.excused && h4.score.is_none() && h4.graded);
    // Graded but not posted yet: no score, not counted as graded, not an error.
    let mid = by("Midterm");
    assert!(mid.score.is_none() && mid.percent.is_none() && !mid.graded && mid.submitted);
    let quiz = by("Quiz week 3 (paper)");
    assert_eq!((quiz.grade.as_deref(), quiz.percent), (Some("A-"), Some(95.0)));
    assert_eq!(quiz.comments, vec!["Strong work on graphs."]);
    let fe = by("Final exam");
    assert!(!fe.graded && !fe.excused && fe.score.is_none());
    // By due date, undated last.
    assert_eq!(g.items.first().unwrap().title, "Homework 1");
    assert_eq!(g.items.last().unwrap().title, "Quiz week 3 (paper)");
    fake::assert_read_only_with_session(&log, "_normandy_session=sess123");
}

#[tokio::test(flavor = "multi_thread")]
async fn unweighted_course_has_points_out_of_whats_graded_and_no_weights() {
    let (base, _) = fake::serve(site(false)).await;
    let g = grades(&session(&base), "1001").await.unwrap();
    assert!(g.groups.iter().all(|gr| gr.weight.is_none()));
    // 9 + 7 + 0 (homework 4 excused, midterm not posted) + 152 → out of 10+10+10+160.
    assert_eq!(g.current.possible, Some(190.0));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_grade_book_is_empty_with_a_note() {
    // Canvas answers 401 "unauthorized" when the person may not see something.
    let (base, _) = fake::serve(Arc::new(|t: &str| match path(t).as_str() {
        "/api/v1/users/self" => json(r#"{"id":42}"#),
        _ => Reply { status: 401, ctype: "application/json", headers: vec![], body: r#"{"status":"unauthorized"}"#.into() },
    }))
    .await;
    let g = grades(&session(&base), "1001").await.unwrap();
    assert!(g.items.is_empty() && g.current.is_empty());
    assert_eq!(g.note.as_deref(), Some(crate::lms::GRADES_HIDDEN));
    let (base, _) = fake::serve(Arc::new(|_: &str| status(403))).await;
    assert_eq!(grades(&session(&base), "1001").await.unwrap().note.as_deref(), Some(crate::lms::GRADES_HIDDEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn signed_out_is_an_error() {
    let (base, _) = fake::serve(Arc::new(|_: &str| status(401))).await;
    assert_eq!(grades(&session(&base), "1001").await.unwrap_err(), LmsError::SignedOut);
    let (base, _) = fake::serve(Arc::new(|t: &str| if t.starts_with("/login") { fake::html("<form>Sign in</form>") } else { redirect("/login") })).await;
    assert_eq!(grades(&session(&base), "1001").await.unwrap_err(), LmsError::SignedOut);
    assert!(matches!(grades(&session(&base), "../users").await, Err(LmsError::NotFound(_))));
}
