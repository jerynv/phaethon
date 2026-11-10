import { LibraryBigIcon } from "lucide-react";
import { useNav } from "@/app/nav";
import { SpaceMark } from "@/app/SpaceMark";
import { switchSpace, useSpaces } from "@/app/spaces";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection } from "@/components/ui/settings";

/**
 * Course sites live in each school space's Courses view (sign-in, import,
 * access). This section points there, or says how to get school features.
 */
export function CoursesSettings() {
  const spaces = useSpaces((s) => s.spaces);
  const closeSettings = useNav((s) => s.closeSettings);
  const openSettings = useNav((s) => s.openSettings);
  const school = spaces.filter((s) => s.educationEnabled);

  return (
    <SettingsPage>
      <SettingsSection
        title="Course sites"
        description="Connect Canvas, Brightspace, Moodle or Blackboard from a school space’s Courses view."
      >
        {school.length > 0 ? (
          <SettingsGroup>
            {school.map((s) => (
              <SettingsRow
                key={s.id}
                title={
                  <span className="flex items-center gap-2">
                    <SpaceMark name={s.name} hue={s.hue} className="size-5" />
                    {s.name}
                  </span>
                }
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      closeSettings();
                      switchSpace(s.id, { kind: "courses" });
                    }}
                  >
                    <LibraryBigIcon />
                    Open Courses
                  </Button>
                }
              />
            ))}
          </SettingsGroup>
        ) : (
          <SettingsGroup>
            <SettingsRow
              title="No space has school features yet"
              description="Turn them on for a space to add Study, Grades, Plan and Courses."
              control={
                <Button size="sm" variant="outline" onClick={() => openSettings("spaces")}>
                  Choose a space
                </Button>
              }
            />
          </SettingsGroup>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
