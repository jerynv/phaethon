//! Blackboard Learn grades against a local fake Learn, with replies shaped like
//! the Learn REST docs' gradebook columns, grades and categories.

use super::*;
use crate::lms::fake::{self, html, json, redirect, status};
use crate::lms::{Cookie, Kind, Site};
use std::sync::Arc;

fn session(base: &str) -> Session {
    let cookies = vec![Cookie { name: "BbRouter".into(), value: "expires:1,id:A,user:4711,xsrf:t".into() }];
    Session::new(Site::for_test(Kind::Blackboard, base), Credential { cookies, csrf: Some("t".into()) })
}

const ME: &str = "/learn/api/public/v1/users/me";
const COLS: &str = "/learn/api/public/v2/courses/_100_1/gradebook/columns?limit=100";
const MINE: &str = "/learn/api/public/v2/courses/_100_1/gradebook/users/_4711_1?limit=100";
const CATS: &str = "/learn/api/public/v1/courses/_100_1/gradebook/categories";

fn me() -> fake::Reply {
    json(include_str!("../../../tests/fixtures/blackboard/users_me.json"))
}

fn categories() -> fake::Reply {
    json(r#"{"results":[{"id":"_31_1","title":"Labs","description":""},{"id":"_32_1","title":"Exams"}]}"#)
}

#[tokio::test(flavor = "multi_thread")]
async fn columns_and_my_grades() {
    let (base, log) = fake::serve(Arc::new(|t: &str| match t {
        ME => me(),
        COLS => json(include_str!("../../../tests/fixtures/blackboard/grades_columns.json")),
        MINE => json(include_str!("../../../tests/fixtures/blackboard/grades_mine.json")),
        CATS => categories(),
        _ => status(404),
    }))
    .await;
    let g = grades(&session(&base), "_100_1").await.unwrap();
    assert_eq!(g.current, GradeSummary { percent: Some(86.4), letter: Some("B+".into()), points: Some(432.0), possible: Some(500.0) });
    assert_eq!(g.groups, vec![GradeGroup { name: "Labs".into(), weight: None }, GradeGroup { name: "Exams".into(), weight: None }]);
    let titles: Vec<&str> = g.items.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titles, vec!["Lab 1", "Lab 2", "Exam 1"], "the overall column isn't an item; a hidden column isn't there");
    let lab1 = &g.items[0];
    assert_eq!((lab1.score, lab1.possible, lab1.percent, lab1.grade.as_deref()), (Some(18.0), Some(20.0), Some(90.0), None));
    assert_eq!(lab1.due.as_deref(), Some("2026-09-12T03:59:00.000Z"));
    assert_eq!(lab1.comments, vec!["Clear write-up. Label your axes."]);
    assert!(lab1.graded && lab1.submitted);
    let lab2 = &g.items[1];
    assert!(lab2.submitted && !lab2.graded && lab2.score.is_none());
    assert_eq!((g.items[2].grade.as_deref(), g.items[2].group.as_deref()), (Some("A-"), Some("Exams")));
    fake::assert_read_only_with_session(&log, "BbRouter=");
}

#[tokio::test(flavor = "multi_thread")]
async fn one_column_at_a_time_when_the_list_is_refused() {
    let (base, _) = fake::serve(Arc::new(|t: &str| match t {
        ME => me(),
        COLS => json(include_str!("../../../tests/fixtures/blackboard/grades_columns.json")),
        MINE => status(403),
        "/learn/api/public/v2/courses/_100_1/gradebook/columns/_802_1/users/_4711_1" => {
            json(r#"{"userId":"_4711_1","columnId":"_802_1","status":"Graded","score":17.0,"displayGrade":{"scaleType":"Score","score":17.0,"text":"17"}}"#)
        }
        _ => status(404),
    }))
    .await;
    let g = grades(&session(&base), "_100_1").await.unwrap();
    assert_eq!(g.items.iter().find(|i| i.title == "Lab 1").unwrap().score, Some(17.0));
    assert!(g.items.iter().filter(|i| i.title != "Lab 1").all(|i| i.score.is_none()), "not released: absent, not an error");
    assert!(g.groups.is_empty(), "categories refused: no groups");
}

#[tokio::test(flavor = "multi_thread")]
async fn refused_is_empty_with_a_note_and_signed_out_is_an_error() {
    let (base, _) = fake::serve(Arc::new(|t: &str| if t == ME { me() } else { status(403) })).await;
    let g = grades(&session(&base), "_100_1").await.unwrap();
    assert_eq!(g.note.as_deref(), Some(crate::lms::GRADES_HIDDEN));
    assert!(g.items.is_empty());
    let (base, _) = fake::serve(Arc::new(|t: &str| if t.starts_with("/webapps/login") { html("<form></form>") } else { redirect("/webapps/login/") })).await;
    assert_eq!(grades(&session(&base), "_100_1").await.unwrap_err(), LmsError::SignedOut);
}
