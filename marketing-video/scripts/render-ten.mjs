import {mkdirSync} from "node:fs";
import {spawnSync} from "node:child_process";

const ids = [
  "01-Fragmented-To-One",
  "02-Before-Its-Urgent",
  "03-Client-To-Cash",
  "04-Same-Live-Context",
  "05-Ask-One-Question",
  "06-Monday-Reading",
  "07-Built-For-Services",
  "08-Update-Once",
  "09-Noise-To-Signal",
  "10-The-Outcome",
];

mkdirSync("out/concepts", {recursive: true});

for (const id of ids) {
  console.log(`\nRendering ${id}`);
  const result = spawnSync(
    "bunx",
    [
      "remotion",
      "render",
      "src/index.ts",
      id,
      `out/concepts/${id}.mp4`,
      "--codec=h264",
      "--crf=17",
      "--pixel-format=yuv420p",
    ],
    {stdio: "inherit"},
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
