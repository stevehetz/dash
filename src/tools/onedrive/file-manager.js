import fs from "fs/promises";
import path from "path";

/**
 * Safe file operations scoped to the OneDrive notes directory.
 * All paths are resolved relative to ONEDRIVE_PATH and
 * cannot escape outside that boundary.
 */
export class FileManager {
  constructor(onedriveePath) {
    this.root = path.resolve(onedriveePath);
  }

  /**
   * Resolve a user-provided path safely within the OneDrive notes root.
   * Throws if the resolved path escapes the root.
   */
  _safePath(relativePath) {
    const resolved = path.resolve(this.root, relativePath || ".");
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Access denied: "${relativePath}" resolves outside OneDrive notes folder`
      );
    }
    return resolved;
  }

  _assertNotProtectedDirectory(filePath, relativePath) {
    const relative = path.relative(this.root, filePath).split(path.sep).join("/");
    const protectedDirs = new Set([
      "",
      "dashbook",
      "dashbook/app",
      "dashbook/dash",
      "dashbook/data",
      "dashbook/images",
      "dashbook/notes",
      "screencaps",
      "storage",
    ]);

    if (protectedDirs.has(relative)) {
      throw new Error(`Refusing to delete protected directory: ${relativePath}`);
    }
  }

  /** List files and folders at a given path (default: root) */
  async listDir(relativePath = ".") {
    const dirPath = this._safePath(relativePath);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    return entries
      .filter((e) => !e.name.startsWith(".")) // skip hidden files
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "folder" : "file",
        path: path.relative(this.root, path.join(dirPath, e.name)),
      }));
  }

  /** Read a file and return its contents */
  async readFile(relativePath) {
    const filePath = this._safePath(relativePath);
    return await fs.readFile(filePath, "utf-8");
  }

  /** Write content to a file (creates parent dirs if needed) */
  async writeFile(relativePath, content) {
    const filePath = this._safePath(relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  /** Append content to a file (creates it if it doesn't exist) */
  async appendFile(relativePath, content) {
    const filePath = this._safePath(relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Ensure existing file ends with a newline before appending
    try {
      const existing = await fs.readFile(filePath, "utf-8");
      if (existing.length > 0 && !existing.endsWith("\n")) {
        await fs.appendFile(filePath, "\n", "utf-8");
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
    const safeContent = content.endsWith("\n") ? content : content + "\n";
    await fs.appendFile(filePath, safeContent, "utf-8");
    return filePath;
  }

  /** Write a base64-encoded binary file (e.g. images) */
  async writeImageFile(relativePath, base64Data) {
    const filePath = this._safePath(relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const buffer = Buffer.from(base64Data, "base64");
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  /** Delete a file */
  async deleteFile(relativePath) {
    const filePath = this._safePath(relativePath);
    await fs.unlink(filePath);
    return filePath;
  }

  /** Delete a directory */
  async deleteDirectory(relativePath, { recursive = false } = {}) {
    const dirPath = this._safePath(relativePath);
    this._assertNotProtectedDirectory(dirPath, relativePath);

    const stats = await fs.lstat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${relativePath}`);
    }

    if (recursive) {
      await fs.rm(dirPath, { recursive: true, force: false });
    } else {
      await fs.rmdir(dirPath);
    }

    return dirPath;
  }

  /** Check if a file or folder exists */
  async exists(relativePath) {
    try {
      const filePath = this._safePath(relativePath);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Get the folder structure (2 levels deep) for context */
  async getFolderOverview(relativePath = ".", depth = 2) {
    const result = [];
    await this._walkDir(relativePath, result, 0, depth);
    return result;
  }

  async _walkDir(relativePath, result, currentDepth, maxDepth) {
    if (currentDepth >= maxDepth) return;

    try {
      const entries = await this.listDir(relativePath);
      for (const entry of entries) {
        const indent = "  ".repeat(currentDepth);
        const icon = entry.type === "folder" ? "📁" : "📄";
        result.push(`${indent}${icon} ${entry.name}`);

        if (entry.type === "folder") {
          await this._walkDir(entry.path, result, currentDepth + 1, maxDepth);
        }
      }
    } catch {
      // Permission or access error — skip silently
    }
  }
}
