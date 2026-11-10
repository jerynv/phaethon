import type { Session } from "../session.ts";
import type { Course, CourseContent, CourseGrades, Credential, LoginNav } from "../types.ts";

/**
 * What each site adapter exports. Adapters talk to the network only through
 * `Session`, and throw `LmsError`s.
 */
export interface Adapter {
  /** The page the login window opens. */
  loginUrl(base: URL): URL;
  /** The credential once the person is signed in (null: not yet). Called after each page load and every 1.5 s. */
  loginResult(base: URL, nav: LoginNav): Credential | null;
  courses(s: Session): Promise<Course[]>;
  content(s: Session, courseId: string): Promise<CourseContent>;
  grades(s: Session, courseId: string): Promise<CourseGrades>;
  /** The signed-in account's id from the site's documented "who am I" call. Absent for Moodle. */
  account?(s: Session): Promise<string>;
}
