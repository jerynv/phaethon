//! Brightspace grades against a local fake site, with replies shaped like the
//! Valence docs' GradeValue, GradeObjectCategory and GradeSetupInfo blocks.

use super::*;
use crate::lms::fake::{self, html, json, redirect, status};
use crate::lms::{Cookie, Kind, Site};
use std::sync::Arc;

const LE: &str = "/d2l/api/le/1.82/6606";

fn session(base: &str) -> Session {
    let cookies = vec![Cookie { name: "d2lSessionVal".into(), value: "s3ss10n".into() }, Cookie { name: "d2lSecureSessionVal".into(), value: "s3cur3".into() }];
    Session::new(Site::for_test(Kind::Brightspace, base), Credential { cookies, csrf: None })
}

fn common(t: &str) -> Option<fake::Reply> {
    Some(match t {
        "/d2l/api/versions/" => json(include_str!("../../../tests/fixtures/brightspace/versions.json")),
        "/d2l/api/lp/1.49/users/whoami" => json(include_str!("../../../tests/fixtures/brightspace/whoami.json")),
        _ => return None,
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn released_grades_with_weights_and_the_final_grade() {
    let (base, log) = fake::serve(Arc::new(|t: &str| {
        common(t).unwrap_or_else(|| match t.strip_prefix(LE).unwrap_or("") {
            "/grades/values/myGradeValues/" => json(include_str!("../../../tests/fixtures/brightspace/my-grade-values.json")),
            "/grades/final/values/myGradeValue" => json(include_str!("../../../tests/fixtures/brightspace/my-final-grade.json")),
            "/grades/categories/" => json(include_str!("../../../tests/fixtures/brightspace/grade-categories.json")),
            "/grades/setup/" => json(r#"{"GradingSystem":"Weighted","IsNullGradeZero":false,"DefaultGradeSchemeId":12}"#),
            // Students are often refused the grade object list: the categories still name things.
            "/grades/" => status(403),
            _ => status(404),
        })
    }))
    .await;
    let g = grades(&session(&base), "6606").await.unwrap();
    assert_eq!(g.current.percent, Some(86.5));
    assert_eq!(g.current.letter.as_deref(), Some("B+"));
    assert_eq!((g.current.points, g.current.possible), (Some(86.5), Some(100.0)));
    assert_eq!(g.groups, vec![GradeGroup { name: "Exams".into(), weight: Some(60.0) }, GradeGroup { name: "Problem Sets".into(), weight: Some(40.0) }]);
    let titles: Vec<&str> = g.items.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titles, vec!["Problem Set 1", "Midterm", "Final Exam", "Problem Set 2"], "the category subtotal isn't an item; unreleased ones are listed ungraded");
    let ps1 = &g.items[0];
    assert_eq!((ps1.score, ps1.possible, ps1.percent), (Some(18.0), Some(20.0), Some(90.0)));
    assert_eq!(ps1.group.as_deref(), Some("Problem Sets"));
    assert!(ps1.graded && ps1.grade.is_none());
    assert_eq!(ps1.comments, vec!["Good work. Show the steps next time."]);
    assert_eq!(g.items[1].grade.as_deref(), Some("B"));
    let fe = &g.items[2];
    assert!(!fe.graded && fe.score.is_none() && fe.possible == Some(50.0) && fe.group.as_deref() == Some("Exams"));
    fake::assert_read_only_with_session(&log, "d2lSessionVal=s3ss10n");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_grade_book_is_empty_with_a_note_and_an_ended_session_is_signed_out() {
    let (base, _) = fake::serve(Arc::new(|t: &str| common(t).unwrap_or_else(|| status(403)))).await;
    let g = grades(&session(&base), "6606").await.unwrap();
    assert_eq!(g.note.as_deref(), Some(crate::lms::GRADES_HIDDEN));
    assert!(g.items.is_empty() && g.groups.is_empty());

    let (base, _) = fake::serve(Arc::new(|t: &str| match t {
        "/d2l/api/versions/" => json(include_str!("../../../tests/fixtures/brightspace/versions.json")),
        "/d2l/login?sessionExpired=1" => html("<html>Login</html>"),
        _ => redirect("/d2l/login?sessionExpired=1"),
    }))
    .await;
    assert_eq!(grades(&session(&base), "6606").await.unwrap_err(), LmsError::SignedOut);
    assert!(matches!(grades(&session(&base), "66/06").await, Err(LmsError::NotFound(_))));
}
