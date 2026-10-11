//! Moodle. Not written yet: every call says so.

use super::{Course, CourseContent, Credential, LmsError, LoginNav, Session};
use url::Url;

pub fn login_url(base: &Url) -> Url {
    base.clone()
}

pub fn login_result(_base: &Url, _nav: &LoginNav) -> Option<Credential> {
    None
}

pub async fn courses(_s: &Session) -> Result<Vec<Course>, LmsError> {
    Err(LmsError::Unsupported("Moodle isn’t supported yet.".into()))
}

pub async fn content(_s: &Session, _course_id: &str) -> Result<CourseContent, LmsError> {
    Err(LmsError::Unsupported("Moodle isn’t supported yet.".into()))
}
