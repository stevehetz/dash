import { BrowserManager } from "./browser-manager.js";

const browser = new BrowserManager();

/**
 * Helper to build a tool result with a screenshot image that Claude can see.
 */
function withScreenshot(text, screenshot) {
  return [
    { type: "text", text },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: screenshot,
      },
    },
  ];
}

const tools = [
  {
    name: "browser_navigate",
    description:
      "Open a URL in the headless browser. Returns a screenshot of the page.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element on the page. Accepts a CSS selector (e.g. '#submit', '.btn') or button/link text (e.g. 'Sign In'). Returns a screenshot after clicking.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector or visible text of the element to click.",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into an input field. Replaces any existing text in the field. Returns a screenshot after typing.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the input field (e.g. '#email', 'input[name=\"search\"]').",
        },
        text: {
          type: "string",
          description: "The text to type into the field.",
        },
        press_enter: {
          type: "boolean",
          description: "Press Enter after typing. Default false.",
        },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "browser_select",
    description: "Select an option from a dropdown/select element.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the select element.",
        },
        value: {
          type: "string",
          description: "The value attribute of the option to select.",
        },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "browser_get_text",
    description:
      "Get the text content of the page or a specific element. Useful for reading content without a screenshot.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the element. Omit to get full page text.",
        },
      },
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Execute JavaScript code in the browser and return the result. Use for complex interactions or reading page data.",
    input_schema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript code to execute in the browser context.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "browser_close",
    description: "Close the browser. Call when done with browser tasks.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

const systemPrompt = `

## Browser automation
- For simple lookups prefer web_search/web_fetch. Use the browser only for interactive work: forms, logins, multi-step flows.
- Every action returns a screenshot, so you can see the result.
- Close the browser when you're done.
`;

function createHandler() {
  return async (toolName, toolInput) => {
    switch (toolName) {
      case "browser_navigate": {
        const { title, url, screenshot } = await browser.navigate(toolInput.url);
        return withScreenshot(`Navigated to "${title}" (${url})`, screenshot);
      }
      case "browser_screenshot": {
        const { title, url, screenshot } = await browser.screenshot();
        return withScreenshot(`Screenshot of "${title}" (${url})`, screenshot);
      }
      case "browser_click": {
        const { url, screenshot } = await browser.click(toolInput.selector);
        return withScreenshot(`Clicked "${toolInput.selector}" — now on ${url}`, screenshot);
      }
      case "browser_type": {
        const { url, screenshot } = await browser.type(
          toolInput.selector,
          toolInput.text,
          { pressEnter: toolInput.press_enter },
        );
        return withScreenshot(`Typed into "${toolInput.selector}" — on ${url}`, screenshot);
      }
      case "browser_select": {
        const { url, screenshot } = await browser.select(toolInput.selector, toolInput.value);
        return withScreenshot(`Selected "${toolInput.value}" in "${toolInput.selector}" — on ${url}`, screenshot);
      }
      case "browser_get_text": {
        const text = await browser.getText(toolInput.selector);
        return text;
      }
      case "browser_evaluate": {
        const result = await browser.evaluate(toolInput.code);
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      }
      case "browser_close": {
        await browser.close();
        return "Browser closed.";
      }
    }
  };
}

export default { name: "browser", tools, systemPrompt, createHandler };
