/**
 * Reads the repository's .env into the environment, so a command does not have
 * to carry --env-file and a service started by hand behaves like one started
 * by Docker. Nothing here depends on dotenv: Node reads the file itself.
 *
 * Node never lets a file overwrite a variable the process already has, so a
 * value left behind in a shell quietly wins over the file and the file looks
 * as if it was never read. Every name that happens to is reported by name,
 * because that is the one failure this file would otherwise hide.
 *
 * CHAINAIM_ENV_FILE names a different file. A file that is not there is not an
 * error: in a container the configuration arrives as real environment
 * variables and there is no .env to read.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The repository root: three levels above src/ and above scripts/, where .env.example lives. */
export const DEFAULT_ENV_FILE = resolve(import.meta.dirname, "..", "..", "..", ".env");

/**
 * The names a KEY=VALUE file sets, each once, in the order they first appear.
 * Node's own parser reads the values; this only needs the names, to say which
 * of them the environment already holds.
 */
export function namesIn(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names];
}

export type LoadedEnv = {
  /** The file that was looked for, whether or not it was there. */
  path: string;
  loaded: boolean;
  /** Names the file sets that the environment already held, so the file's values were not used. */
  shadowed: string[];
};

/**
 * @param path the file to read; CHAINAIM_ENV_FILE, then the repository's .env
 * @param warn where a shadowed name is reported; stderr, so it never lands in piped output
 */
export function loadEnv(
  path: string = process.env.CHAINAIM_ENV_FILE?.trim() || DEFAULT_ENV_FILE,
  warn: (line: string) => void = (line) => console.error(line),
): LoadedEnv {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { path, loaded: false, shadowed: [] };
  }
  const held = new Set(Object.keys(process.env));
  process.loadEnvFile(path);
  const shadowed = namesIn(text).filter((name) => held.has(name));
  for (const name of shadowed) {
    warn(`[chainaim] ${name} is already set in this environment and overrides ${path}; unset it to use the file's value`);
  }
  return { path, loaded: true, shadowed };
}
