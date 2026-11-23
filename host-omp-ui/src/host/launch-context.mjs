import { constants } from "node:fs";
import { mkdir, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname, basename } from "node:path";

function checkPrivate(info, kind) {
  if ((kind === "directory" ? !info.isDirectory() : !info.isFile()) ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error(`Unsafe launch context ${kind}`);
  }
}

function validate(port, token) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== "string" || !token) {
    throw new Error("Invalid launch context");
  }
}

async function privateDirectory(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  checkPrivate(await lstat(directory), "directory");
}

// Delete only expired files belonging to this module. Never read their contents.
export async function pruneLaunchContexts({ directory, maxAgeMs = 600_000, now = Date.now() }) {
  const result = { removed: 0, kept: 0, diagnostics: [] };
  try {
    await privateDirectory(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw new Error("Unsafe launch context directory");
  }
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const names = new RegExp(`^(?:${uuid}\\.json|\\.${uuid}\\.json\\.${uuid}\\.claimed)$`, "i");
  for (const name of await readdir(directory)) {
    if (!names.test(name)) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || now - info.mtimeMs <= maxAgeMs) {
        result.kept++;
        continue;
      }
      await unlink(path);
      result.removed++;
    } catch (error) {
      if (error?.code !== "ENOENT") result.diagnostics.push({ path, code: error?.code ?? "cleanup_failed", message: "Could not remove stale launch context" });
    }
  }
  return result;
}

export async function createLaunchContext({ directory, port, token }) {
  validate(port, token);
  await privateDirectory(directory, true);
  const path = join(directory, `${randomUUID()}.json`);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(JSON.stringify({ port, token }), "utf8");
    await handle.close();
    return path;
  } catch {
    await handle?.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw new Error("Could not create launch context");
  }
}

export async function consumeLaunchContext(path) {
  const directory = dirname(path);
  let claimed;
  let handle;
  try {
    await privateDirectory(directory);
    checkPrivate(await lstat(path), "file");
    // Rename is the single-consumer claim; no second process can consume this path.
    claimed = join(directory, `.${basename(path)}.${randomUUID()}.claimed`);
    await rename(path, claimed);
    handle = await open(claimed, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    checkPrivate(await handle.stat(), "file");
    const content = await handle.readFile("utf8");
    const data = JSON.parse(content);
    validate(data?.port, data?.token);
    return { port: data.port, token: data.token };
  } catch {
    throw new Error("Could not consume launch context");
  } finally {
    await handle?.close().catch(() => {});
    if (claimed) await unlink(claimed).catch(() => {});
  }
}

export async function removeLaunchContext(path) {
  await privateDirectory(dirname(path));
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  checkPrivate(info, "file");
  await unlink(path);
}
