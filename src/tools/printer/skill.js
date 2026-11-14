import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

const PRINTER = "Canon_MG3600_series";

/**
 * Build lp args with common options (grayscale by default, optional page range).
 */
function buildLpArgs(filePath, { copies = 1, pages, color = false } = {}) {
  const args = ["-d", PRINTER, "-n", String(copies)];
  // Default to grayscale unless color is explicitly requested
  if (!color) args.push("-o", "ColorModel=Gray");
  // Fit content to page (prevents oversized images from being cropped/blank)
  args.push("-o", "fit-to-page");
  if (pages) args.push("-P", String(pages));
  args.push(filePath);
  return args;
}

const tools = [
  {
    name: "print_text",
    description:
      "Print text content on Steve's Canon printer. Use for notes, lists, recipes, directions, etc.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text content to print.",
        },
        copies: {
          type: "number",
          description: "Number of copies. Default 1.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "print_file",
    description:
      "Print a file from Steve's OneDrive. Supports PDF, text, images, etc. Prints in grayscale by default.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path within OneDrive (e.g. 'dashbook/notes/steve.md', 'screencaps/label.jpg').",
        },
        copies: {
          type: "number",
          description: "Number of copies. Default 1.",
        },
        pages: {
          type: "string",
          description: "Page range to print (e.g. '1', '1-3', '2'). Omit to print all pages.",
        },
        color: {
          type: "boolean",
          description: "Print in color. Default false (grayscale).",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "print_pending_document",
    description:
      "Print the most recently received Telegram document (PDF, image, etc.). Use this when Steve sends a file via Telegram and asks you to print it. Prints in grayscale by default.",
    input_schema: {
      type: "object",
      properties: {
        copies: {
          type: "number",
          description: "Number of copies. Default 1.",
        },
        pages: {
          type: "string",
          description: "Page range to print (e.g. '1', '1-3', '2'). Omit to print all pages.",
        },
        color: {
          type: "boolean",
          description: "Print in color. Default false (grayscale).",
        },
      },
    },
  },
  {
    name: "print_pending_image",
    description:
      "Print the most recently received Telegram photo/image. Use this when Steve sends a photo via Telegram and asks you to print it. Prints in grayscale by default.",
    input_schema: {
      type: "object",
      properties: {
        copies: {
          type: "number",
          description: "Number of copies. Default 1.",
        },
        color: {
          type: "boolean",
          description: "Print in color. Default false (grayscale).",
        },
      },
    },
  },
];

const systemPrompt = `

## Printing (Canon MG3600)
- Default is 1 copy, grayscale, all pages, unless Steve says otherwise.
- For multi-page PDFs such as Amazon return labels, print ALL pages — the label and the barcode slip are both needed.
- print_file takes a OneDrive path relative to dashbook/. print_pending_document and print_pending_image use whatever Steve just sent on Telegram.
`;

function createHandler({ fileManager }) {
  return async (toolName, toolInput) => {
    switch (toolName) {
      case "print_text": {
        const copies = toolInput.copies || 1;
        const tmpPath = join(tmpdir(), `dash-print-${Date.now()}.txt`);
        try {
          await writeFile(tmpPath, toolInput.text, "utf-8");
          const args = buildLpArgs(tmpPath, { copies });
          await execFileAsync("lp", args);
          return `Sent to printer (${copies} copy/copies, grayscale).`;
        } finally {
          await unlink(tmpPath).catch(() => {});
        }
      }
      case "print_file": {
        const copies = toolInput.copies || 1;
        const onedrivePath = process.env.ONEDRIVE_PATH || process.env.DROPBOX_PATH;
        const fullPath = join(onedrivePath, toolInput.path);

        // Basic path traversal check
        if (!fullPath.startsWith(onedrivePath)) {
          return "Error: path must be within OneDrive.";
        }

        const args = buildLpArgs(fullPath, { copies, pages: toolInput.pages, color: toolInput.color });
        await execFileAsync("lp", args);
        return `Sent ${toolInput.path} to printer (${copies} copy/copies${toolInput.pages ? `, pages ${toolInput.pages}` : ""}${toolInput.color ? ", color" : ", grayscale"}).`;
      }
      case "print_pending_document": {
        if (!fileManager.pendingDocument) {
          return "Error: no document received recently. Send a file via Telegram first.";
        }
        const copies = toolInput.copies || 1;
        const { buffer, fileName } = fileManager.pendingDocument;
        const ext = fileName?.split(".").pop() || "pdf";
        const tmpPath = join(tmpdir(), `dash-print-${Date.now()}.${ext}`);
        try {
          await writeFile(tmpPath, buffer);
          const args = buildLpArgs(tmpPath, { copies, pages: toolInput.pages, color: toolInput.color });
          await execFileAsync("lp", args);
          return `Sent ${fileName || "document"} to printer (${copies} copy/copies${toolInput.pages ? `, pages ${toolInput.pages}` : ""}${toolInput.color ? ", color" : ", grayscale"}).`;
        } finally {
          await unlink(tmpPath).catch(() => {});
          fileManager.pendingDocument = null;
        }
      }
      case "print_pending_image": {
        if (!fileManager.pendingImage) {
          return "Error: no image received recently. Send a photo via Telegram first.";
        }
        const copies = toolInput.copies || 1;
        const { base64, mimeType } = fileManager.pendingImage;
        const ext = mimeType?.split("/")[1] || "jpg";
        const imgPath = join(tmpdir(), `dash-print-${Date.now()}.${ext}`);
        const pdfPath = imgPath.replace(/\.\w+$/, ".pdf");
        try {
          await writeFile(imgPath, Buffer.from(base64, "base64"));
          // Convert image to PDF, then print with fit-to-page
          await execFileAsync("sips", ["-s", "format", "pdf", imgPath, "--out", pdfPath], { timeout: 10000 });
          const args = buildLpArgs(pdfPath, { copies, color: toolInput.color });
          await execFileAsync("lp", args);
          return `Sent image to printer (${copies} copy/copies${toolInput.color ? ", color" : ", grayscale"}).`;
        } finally {
          await unlink(imgPath).catch(() => {});
          await unlink(pdfPath).catch(() => {});
        }
      }
    }
  };
}

export default { name: "printer", tools, systemPrompt, createHandler };
