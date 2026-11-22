/**
 * Every word in the update dialogs: "update available" (shown when the check
 * after launch finds a newer release) and "what’s new" (shown once, on the
 * first launch after Phaethon updated itself). Readers are mostly
 * non-technical. Plain words, short sentences, sentence case, curly
 * apostrophes (’), no exclamation marks, no em dashes.
 */

export const UPDATE_COPY = {
  available: {
    /** Small label above the title. */
    eyebrow: "Update available",
    title: (version: string) => `Phaethon ${version} is ready`,
    /** Under the title. `current` is the version running now. */
    subtitle: (current: string) => `You’re on ${current}. Installing keeps all your data.`,
    released: (date: string) => `Released ${date}`,
    notesHeading: "What’s in this update",
    noNotes: "Includes fixes and improvements.",
    install: "Install and restart",
    installing: "Installing…",
    later: "Later",
    skip: "Skip this version",
    /** A copy that didn't come from a release (a development or dev build) can't install over itself. */
    devBuild: "This copy wasn’t installed from a release, so it can’t update itself. Download the new version from the releases page.",
    openReleases: "Open releases page",
    progress: {
      downloading: "Downloading…",
      installing: "Installing…",
      restarting: "Restarting Phaethon…",
    },
    failed: "Couldn’t install the update",
  },
  whatsNew: {
    eyebrow: "Updated",
    title: (version: string) => `What’s new in Phaethon ${version}`,
    subtitle: "Phaethon is up to date. Here’s what changed.",
    done: "Got it",
  },
  /** Settings › About links to the dialog. */
  about: {
    seeNotes: "See what’s new",
  },
} as const;
