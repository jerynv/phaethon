//! Moodle grades from the person's user report page, shaped as Moodle 4.5's
//! gradereport_user draws it (fixtures/grades.html).

use super::*;
use crate::lms::fake::{self, html, redirect, status};
use crate::lms::{Cookie, Kind, Site};
use std::sync::Arc;

fn session(base: &str) -> Session {
    let cookies = vec![Cookie { name: "MoodleSession".into(), value: "s3ss10n".into() }];
    Session::new(Site::for_test(Kind::Moodle, &format!("{base}/moodle/")), Credential { cookies, csrf: None })
}

const REPORT: &str = "/moodle/grade/report/user/index.php?id=7";

#[tokio::test(flavor = "multi_thread")]
async fn the_user_report_with_groups_weights_and_hidden_grades_absent() {
    let (base, log) = fake::serve(Arc::new(|t: &str| match t {
        REPORT => html(include_str!("fixtures/grades.html")),
        _ => status(404),
    }))
    .await;
    let g = grades(&session(&base), "7").await.unwrap();
    assert_eq!(g.note, None);
    assert_eq!(g.current, GradeSummary { percent: Some(86.4), letter: Some("B+".into()), points: Some(86.4), possible: Some(100.0) });
    assert_eq!(
        g.groups,
        vec![GradeGroup { name: "Homework & problem sets".into(), weight: Some(40.0) }, GradeGroup { name: "Exams".into(), weight: Some(60.0) }]
    );
    let titles: Vec<&str> = g.items.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titles, vec!["Homework 1", "Homework 2", "Homework 3", "Midterm", "Participation"], "category and course totals aren't items");
    let h1 = &g.items[0];
    assert_eq!((h1.score, h1.possible, h1.percent), (Some(9.0), Some(10.0), Some(90.0)));
    assert_eq!(h1.group.as_deref(), Some("Homework & problem sets"));
    assert!(h1.graded);
    assert_eq!(h1.comments, vec!["Nice proof. Watch the base case."]);
    // Hidden from the person: no score, not graded, no comment.
    let h2 = &g.items[1];
    assert!(h2.score.is_none() && h2.percent.is_none() && !h2.graded && h2.comments.is_empty() && h2.possible == Some(10.0));
    // Hidden, but Moodle says when it was handed in.
    let h3 = &g.items[2];
    assert!(h3.submitted && !h3.graded && h3.score.is_none() && h3.grade.is_none());
    assert_eq!((g.items[3].score, g.items[3].possible, g.items[3].group.as_deref()), (Some(42.0), Some(50.0), Some("Exams")));
    let p = &g.items[4];
    assert_eq!((p.grade.as_deref(), p.group.as_deref(), p.graded), (Some("Satisfactory"), None, true));
    assert_eq!(p.comments, vec!["Good contributions in week 3."]);
    fake::assert_read_only_with_session(&log, "MoodleSession=s3ss10n");
}

#[tokio::test(flavor = "multi_thread")]
async fn refused_is_empty_with_a_note_and_signed_out_is_an_error() {
    let (base, _) = fake::serve(Arc::new(|_: &str| status(403))).await;
    assert_eq!(grades(&session(&base), "7").await.unwrap().note.as_deref(), Some(crate::lms::GRADES_HIDDEN));
    // Moodle's error page ("you can't view this report") has no grade table.
    let (base, _) = fake::serve(Arc::new(|_: &str| html("<html><body class=\"path-grade\"><div role=\"main\"><p class=\"errormessage\">Sorry, but you do not currently have permissions to do that.</p></div></body></html>"))).await;
    let g = grades(&session(&base), "7").await.unwrap();
    assert!(g.items.is_empty() && g.note.is_some());

    let (base, _) = fake::serve(Arc::new(|t: &str| match t {
        REPORT => redirect("/moodle/login/index.php"),
        _ => html(include_str!("fixtures/login.html")),
    }))
    .await;
    assert_eq!(grades(&session(&base), "7").await.unwrap_err(), LmsError::SignedOut);
    assert!(matches!(grades(&session(&base), "7&x=1").await, Err(LmsError::NotFound(_))));
}
