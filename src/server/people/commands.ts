import { commands, Refusal } from "../rpc/registry.ts";
import { isValidSpaceId } from "../core/vault.ts";
import { allPeople, deletePerson, newPerson, parsePerson, readPerson, savePerson, type Person } from "./people.ts";

/** Settings › People. */

commands({
  people_list: ({ space }: { space?: string }) => {
    const all = allPeople();
    const list = space ? all.filter((p) => p.spaces.includes("*") || p.spaces.includes(space)) : all;
    return list.map((p) => ({ ...p, interactions: p.interactions.slice(-1), interactionCount: p.interactions.length }));
  },

  person_get: ({ id }: { id: string }) => {
    const p = readPerson(id);
    if (!p) throw new Refusal("That person no longer exists.");
    return p;
  },

  person_create: ({ name, space }: { name: string; space: string }) => {
    if (typeof name !== "string" || !name.trim()) throw new Refusal("A person needs a name.");
    if (!isValidSpaceId(space)) throw new Refusal("That isn’t a space.");
    return newPerson({ name: name.trim() }, space, "user");
  },

  person_save: ({ person }: { person: Person }) => {
    const existing = readPerson(person?.id);
    if (!existing) throw new Refusal("That person no longer exists.");
    const p = parsePerson({ ...existing, ...person, id: existing.id, created: existing.created, interactions: person.interactions ?? existing.interactions });
    if (!p) throw new Refusal("A person needs a name.");
    if (!p.spaces.length) throw new Refusal("Choose at least one space that may see this person.");
    return savePerson(p);
  },

  person_delete: ({ id }: { id: string }) => deletePerson(id),
});
