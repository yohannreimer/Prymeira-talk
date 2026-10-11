export type AutomationVariables = Record<string, string>;

const MAX_VARIABLES = 60;
const MAX_KEY_LENGTH = 60;
const MAX_VALUE_LENGTH = 500;
const MAX_INTERPOLATED_VALUE_LENGTH = 300;
const VARIABLE_KEY_PATTERN = /^[\p{L}\p{N}_-]+$/u;
const PLACEHOLDER_PATTERN = /\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function primitiveToString(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "sim" : "não";
  }

  return null;
}

function valueToString(value: unknown) {
  const primitive = primitiveToString(value);
  if (primitive !== null) {
    return primitive;
  }

  if (Array.isArray(value)) {
    return value
      .map(primitiveToString)
      .filter((item): item is string => Boolean(item))
      .join(", ");
  }

  return null;
}

/**
 * Flattens an external JSON payload into string variables. Nested objects are
 * read one level deep as dotted keys (utm.source); arrays of primitives become
 * comma separated lists. Anything else is ignored.
 */
export function flattenAutomationVariables(payload: Record<string, unknown>): AutomationVariables {
  const variables = new Map<string, string>();

  const add = (key: string, value: unknown) => {
    if (variables.size >= MAX_VARIABLES) {
      return;
    }

    const text = valueToString(value);
    if (text === null || text.length === 0) {
      return;
    }

    variables.set(key, text.slice(0, MAX_VALUE_LENGTH));
  };

  for (const [key, value] of Object.entries(payload)) {
    if (key.length > MAX_KEY_LENGTH || !VARIABLE_KEY_PATTERN.test(key)) {
      continue;
    }

    if (isRecord(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childKey.length <= MAX_KEY_LENGTH && VARIABLE_KEY_PATTERN.test(childKey)) {
          add(`${key}.${childKey}`, childValue);
        }
      }
      continue;
    }

    add(key, value);
  }

  // fromEntries defines own properties, so keys like "__proto__" stay plain data.
  return Object.fromEntries(variables);
}

function findVariable(variables: AutomationVariables, key: string) {
  if (Object.hasOwn(variables, key)) {
    return variables[key];
  }

  const normalizedKey = key.toLocaleLowerCase("pt-BR");
  const match = Object.keys(variables).find(
    (candidate) => candidate.toLocaleLowerCase("pt-BR") === normalizedKey
  );

  return match ? variables[match] : undefined;
}

/**
 * Replaces {{campo}} placeholders. Unknown fields become empty text. Values are
 * collapsed to one line and capped because they come from a public form.
 */
export function interpolateAutomationText(text: string, variables: AutomationVariables) {
  return text.replace(PLACEHOLDER_PATTERN, (_placeholder, key: string) => {
    const value = findVariable(variables, key) ?? "";
    return value.replace(/\s+/g, " ").trim().slice(0, MAX_INTERPOLATED_VALUE_LENGTH);
  });
}

function humanizeKey(key: string) {
  const label = key.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return label.charAt(0).toLocaleUpperCase("pt-BR") + label.slice(1);
}

/** Readable lines for the human team, never raw JSON. */
export function formatAutomationVariablesForTeam(title: string, variables: AutomationVariables) {
  const lines = Object.entries(variables).map(
    ([key, value]) => `${humanizeKey(key)}: ${value.replace(/\s*\n\s*/g, " / ")}`
  );

  return [title, ...lines].join("\n");
}
