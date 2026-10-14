/**
 * Measures how well the Brain's classifier routes requests.
 *
 *   npx tsx scripts/eval-classifier.ts            # rules pass only — free, offline
 *   npx tsx scripts/eval-classifier.ts --model    # full hybrid classifier — calls the
 *                                                 # classifier models on the master keys
 *                                                 # (a few hundred tokens per case)
 *
 * Add a case whenever a real request gets misrouted, so it can't regress.
 */
import "dotenv/config";
import type { RouteRequest } from "@convergers-ai/shared-types";
import {
  classifyByRules,
  classifyRequest,
  type TaskType,
} from "../src/modules/brain/classifier";

type Case = { expected: TaskType; request: RouteRequest; note?: string };

const turn = (role: "user" | "assistant", content: string) => ({ role, content });

const CASES: Case[] = [
  // code
  { expected: "code", request: { input: "Write a python script to rename files in a folder" } },
  { expected: "code", request: { input: "Why does my useEffect run twice?" } },
  { expected: "code", request: { input: "Fix this SQL: SELECT * FROM users WHERE id = '1" } },
  { expected: "code", request: { input: "How do I center a div?" } },
  { expected: "code", request: { input: "Build me a to-do app" } },
  { expected: "code", request: { input: "What's the difference between a process and a thread?" } },
  { expected: "code", request: { input: "Explain this error: TypeError: cannot read properties of undefined" } },
  { expected: "code", request: { input: "Create a sample dashboard with charts for sales data" } },
  {
    expected: "code",
    note: "follow-up that only makes sense with history (real misroute)",
    request: {
      input: "I mean programmatically",
      history: [turn("user", "Create sample dashboard"), turn("assistant", "Here's a layout idea for a dashboard…")],
    },
  },
  {
    expected: "code",
    request: {
      input: "seed.js seems incomplete",
      history: [turn("user", "Write a Node script to seed my Postgres DB"), turn("assistant", "```js\n// seed.js\n…")],
    },
  },

  // image
  { expected: "image", request: { input: "Generate an image of a cat astronaut" } },
  { expected: "image", request: { input: "Draw a minimalist logo for a coffee shop called Brew" } },
  { expected: "image", request: { input: "Can you make me a poster for our Diwali sale?" } },
  { expected: "image", request: { input: "Show me what a futuristic Mumbai skyline might look like" } },

  // plan
  { expected: "plan", request: { input: "Create a project plan for launching our app" } },
  { expected: "plan", request: { input: "Plan a 5-day trip to Kerala" } },
  { expected: "plan", request: { input: "Give me a 12-week study schedule for GATE" } },
  { expected: "plan", request: { input: "Roadmap for learning machine learning from scratch" } },

  // research
  { expected: "research", request: { input: "Compare Zerodha, Groww and Upstox for a beginner investor" } },
  { expected: "research", request: { input: "What are the pros and cons of EVs in India right now?" } },
  { expected: "research", request: { input: "Analyse the market for cloud kitchens in Bangalore" } },
  { expected: "research", request: { input: "Summarise recent studies on intermittent fasting" } },

  // math
  { expected: "math", request: { input: "Solve 2x + 3 = 11" } },
  { expected: "math", request: { input: "What is the integral of x^2 sin(x)?" } },
  { expected: "math", request: { input: "Prove that the square root of 2 is irrational" } },
  { expected: "math", request: { input: "Find the eigenvalues of [[2,1],[1,2]]" } },
  { expected: "math", request: { input: "If I roll two dice, what's the probability of getting a sum of 7?" } },
  { expected: "math", request: { input: "A train leaves at 60 km/h and another at 80 km/h an hour later — when does the second catch up?" } },

  // reasoning
  { expected: "reasoning", request: { input: "Here's a riddle: what has keys but can't open locks?" } },
  { expected: "reasoning", request: { input: "Three boxes are all mislabelled — apples, oranges, mixed. You may pick one fruit from one box. How do you fix the labels?" } },
  { expected: "reasoning", request: { input: "If all bloops are razzies and some razzies are lazzies, are some bloops definitely lazzies?" } },

  // writing
  { expected: "writing", request: { input: "Write a short poem about monsoon" } },
  { expected: "writing", request: { input: "Draft an email to my landlord asking to fix the leaking tap" } },
  { expected: "writing", request: { input: "Write a cover letter for a Python developer role", note: "not code" } },
  { expected: "writing", request: { input: "Can you write a toast for my sister's wedding?" } },
  { expected: "writing", request: { input: "Rewrite this email to sound more polite: send me the files now" } },

  // translation
  { expected: "translation", request: { input: "Translate 'good morning' to Hindi" } },
  { expected: "translation", request: { input: "Please translate this paragraph into Tamil: We will reach by 6 pm." } },
  { expected: "code", request: { input: "Translate this Python function to Go", note: "programming language, not translation" } },

  // text
  { expected: "text", request: { input: "Explain photosynthesis simply" } },
  { expected: "text", request: { input: "What's the capital of Australia?" } },
  { expected: "text", request: { input: "What's on the TV program tonight?", note: "'program' is not code" } },
  { expected: "text", request: { input: "Tips for a good morning routine" } },
  { expected: "text", request: { input: "Thanks, that helped!" } },
];

async function main() {
  const useModel = process.argv.includes("--model");
  const byExpected = new Map<TaskType, { total: number; correct: number }>();
  const misses: string[] = [];
  let correct = 0;

  for (const c of CASES) {
    let got: string;
    if (useModel) {
      const { taskType, method } = await classifyRequest(c.request);
      got = `${taskType} (${method})`;
      if (taskType === c.expected) correct++;
      else misses.push(`expected ${c.expected.padEnd(8)} got ${got.padEnd(18)} "${c.request.input}"`);
    } else {
      const taskType = classifyByRules(c.request) ?? "text";
      got = taskType;
      if (taskType === c.expected) correct++;
      else misses.push(`expected ${c.expected.padEnd(8)} got ${got.padEnd(18)} "${c.request.input}"`);
    }
    const bucket = byExpected.get(c.expected) ?? { total: 0, correct: 0 };
    bucket.total++;
    if (got.startsWith(c.expected)) bucket.correct++;
    byExpected.set(c.expected, bucket);
  }

  console.log(`\nClassifier: ${useModel ? "hybrid (rules + model)" : "rules only"}`);
  console.log(`Accuracy: ${correct}/${CASES.length} (${Math.round((correct / CASES.length) * 100)}%)\n`);
  for (const [type, { total, correct: ok }] of byExpected) {
    console.log(`  ${type.padEnd(9)} ${ok}/${total}`);
  }
  if (misses.length) {
    console.log(`\nMisses:`);
    for (const m of misses) console.log(`  ${m}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
