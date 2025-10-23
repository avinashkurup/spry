/**
 * Ensures a `.gitignore` file exists and adds one or more entries if missing.
 * Returns which entries were added and which were already present.
 *
 * @param entries - A string or array of strings to add to the `.gitignore`.
 * @param path - Optional path to the `.gitignore` file; defaults to `${Deno.cwd()}/.gitignore`.
 *
 * @returns An object containing:
 *          - added: entries newly appended
 *          - preserved: entries already present
 *
 * @example
 * const result = await gitignore(["node_modules/", ".env"]);
 * console.log(result); // { added: ["node_modules/"], preserved: [".env"] }
 */
export async function gitignore(
  entries: string | string[],
  path = `${Deno.cwd()}/.gitignore`,
): Promise<{ added: string[]; preserved: string[] }> {
  const lines = Array.isArray(entries) ? entries : [entries];
  let existing: string[] = [];

  try {
    const content = await Deno.readTextFile(path);
    existing = content.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      await Deno.writeTextFile(path, "");
    } else {
      throw err;
    }
  }

  const added: string[] = [];
  const preserved: string[] = [];

  for (const line of lines.map((l) => l.trim()).filter(Boolean)) {
    if (existing.includes(line)) {
      preserved.push(line);
    } else {
      added.push(line);
    }
  }

  if (added.length > 0) {
    await Deno.writeTextFile(path, added.join("\n") + "\n", { append: true });
  }

  return { added, preserved };
}
