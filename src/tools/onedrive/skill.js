const tools = [
  {
    name: "list_directory",
    description:
      "List files and folders at a given path in the OneDrive notes folder. Use '.' or omit the path to list the root. Returns names, types (file/folder), and relative paths.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path within the OneDrive notes folder to list. Defaults to root.",
          default: ".",
        },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file in the OneDrive notes folder. Returns the full text content.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within the OneDrive notes folder.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a text file in the OneDrive notes folder. Use for creating new files or replacing entire file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path for the file within the OneDrive notes folder.",
        },
        content: {
          type: "string",
          description: "The full content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_to_file",
    description:
      "Append content to the end of an existing file (or create it if it doesn't exist). Use for adding entries to food diaries, todo lists, etc.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within the OneDrive notes folder.",
        },
        content: {
          type: "string",
          description: "The content to append to the end of the file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "check_exists",
    description: "Check if a file or folder exists at the given path.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to check within the OneDrive notes folder.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_file",
    description:
      "Delete a file from the OneDrive notes folder. Use when Steve asks to remove or delete a specific file. For folders/directories, use delete_directory instead.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within the OneDrive notes folder.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "delete_directory",
    description:
      "Delete a directory from the OneDrive notes folder. Use only when Steve explicitly asks to remove or delete a folder/directory. Set recursive to true when deleting the folder and all of its contents.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the directory within the OneDrive notes folder.",
        },
        recursive: {
          type: "boolean",
          description:
            "Whether to delete the directory and all files/subdirectories inside it. Defaults to true. Set false only when Steve asks to remove an empty directory without touching contents.",
          default: true,
        },
      },
      required: ["path"],
    },
  },
  {
    name: "save_image",
    description:
      "Save the most recently received photo to the OneDrive notes folder. The image data is already stored — just provide the destination path.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path for the image file (e.g. 'screencaps/screenshot-2026-03-27.jpg').",
        },
      },
      required: ["path"],
    },
  },
];

const systemPrompt = "";

function createHandler({ fileManager }) {
  return async (toolName, toolInput) => {
    switch (toolName) {
      case "list_directory": {
        const entries = await fileManager.listDir(toolInput.path || ".");
        return JSON.stringify(entries, null, 2);
      }
      case "read_file": {
        return await fileManager.readFile(toolInput.path);
      }
      case "write_file": {
        await fileManager.writeFile(toolInput.path, toolInput.content);
        return `File written successfully: ${toolInput.path}`;
      }
      case "append_to_file": {
        await fileManager.appendFile(toolInput.path, toolInput.content);
        return `Content appended to: ${toolInput.path}`;
      }
      case "check_exists": {
        const exists = await fileManager.exists(toolInput.path);
        return exists ? `Yes, ${toolInput.path} exists.` : `No, ${toolInput.path} does not exist.`;
      }
      case "delete_file": {
        await fileManager.deleteFile(toolInput.path);
        return `File deleted: ${toolInput.path}`;
      }
      case "delete_directory": {
        await fileManager.deleteDirectory(toolInput.path, { recursive: toolInput.recursive !== false });
        return `Directory deleted: ${toolInput.path}`;
      }
      case "save_image": {
        if (!fileManager.pendingImage) return "No image available to save. Ask Steve to resend the photo.";
        await fileManager.writeImageFile(toolInput.path, fileManager.pendingImage.base64);
        fileManager.pendingImage = null;
        return `Image saved to: ${toolInput.path}`;
      }
    }
  };
}

export default { name: "onedrive", tools, systemPrompt, createHandler };
