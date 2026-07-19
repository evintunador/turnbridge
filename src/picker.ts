import { createInterface } from "node:readline/promises";

async function ask(promptText: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(promptText)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Numbered terminal picker. Renders to stderr so stdout stays scriptable.
 * Returns null when the user quits.
 */
export async function pickFromList<T>(
  items: T[],
  render: (item: T, index: number) => string,
  promptText: string,
): Promise<T | null> {
  items.forEach((item, i) => process.stderr.write(render(item, i) + "\n"));
  for (;;) {
    const answer = await ask(`${promptText} [1-${items.length}, q to quit]: `);
    if (answer.toLowerCase() === "q" || answer === "") return null;
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!;
    process.stderr.write("Invalid selection.\n");
  }
}

export async function confirm(promptText: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${promptText} ${suffix}: `)).toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}
