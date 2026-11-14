import { execFileSync } from "node:child_process"
import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const build = path.join(root, "build")

async function pack(name, files) {
  const dir = path.join(build, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  for (const file of files) {
    const target = path.join(dir, file.to)
    await mkdir(path.dirname(target), { recursive: true })
    await cp(path.join(root, file.from), target)
  }

  execFileSync(
    "npm",
    ["install", "--omit=dev", "--no-package-lock", "pg@8.16.3", "@aws-sdk/client-s3@3.864.0"],
    { cwd: dir, stdio: "inherit" },
  )

  const zip = path.join(build, `${name}.zip`)
  await rm(zip, { force: true })
  execFileSync("zip", ["-qr", zip, "."], { cwd: dir, stdio: "inherit" })
  console.log(zip)
}

await pack("import-questions", [
  { from: "lambda/import-questions/index.mjs", to: "index.mjs" },
  { from: "lambda/import-questions/logic.mjs", to: "logic.mjs" },
  { from: "questions/quiz-schema.mjs", to: "quiz-schema.mjs" },
])

await pack("export-results", [
  { from: "lambda/export-results/index.mjs", to: "index.mjs" },
  { from: "lambda/export-results/logic.mjs", to: "logic.mjs" },
])
