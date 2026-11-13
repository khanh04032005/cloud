import { createHash } from "node:crypto"
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { parseOpenTrivia, toSingleChoice } from "./parse-opentrivia.mjs"
import { validateRazziaQuiz } from "./quiz-schema.mjs"

const SOURCE_REPO = "https://github.com/uberspot/OpenTriviaQA"
const LICENSE = "CC BY-SA 4.0"
const DEFAULT_CATEGORIES = [
  "geography",
  "history",
  "science-technology",
  "general",
]

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)

  if (index === -1) {
    return fallback
  }

  return process.argv[index + 1]
}

function shuffled(items, seed) {
  const copy = [...items]
  let state = seed >>> 0

  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 2 ** 32
  }

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }

  return copy
}

async function loadCategory(root, category) {
  const file = path.join(root, category)
  const text = await readFile(file, "utf8")

  return { category, text, sha256: createHash("sha256").update(text).digest("hex") }
}

async function main() {
  const root = arg("root", "")
  const outDir = arg("out", path.resolve("questions/out"))
  const seed = Number(arg("seed", "20261026"))
  const loadLimit = Number(arg("load", "8"))
  const bankLimit = Number(arg("bank", "120"))
  const sourceCommit = arg("commit", "unknown")

  if (!root) {
    console.error(
      "Usage: node questions/convert-opentrivia.mjs --root <OpenTriviaQA/categories> [--out questions/out]",
    )
    process.exit(1)
  }

  const available = new Set(await readdir(root))
  const categories = DEFAULT_CATEGORIES.filter((category) => available.has(category))

  if (categories.length === 0) {
    throw new Error(`Không thấy category nào trong ${root}`)
  }

  const pool = []
  const sources = []
  const skipped = {}

  for (const category of categories) {
    const loaded = await loadCategory(root, category)
    const parsed = parseOpenTrivia(loaded.text)
    const converted = toSingleChoice(parsed, {
      cooldown: 3,
      time: 20,
      maxPoints: 1,
    })

    sources.push({
      category,
      sha256: loaded.sha256,
      parsed: parsed.length,
      kept: converted.questions.length,
      skipped: converted.skipped,
    })
    skipped[category] = converted.skipped

    for (const question of converted.questions) {
      pool.push({ ...question, category })
    }
  }

  const ordered = shuffled(pool, seed)
  const bank = ordered.slice(0, bankLimit).map(withoutCategory)
  const load = ordered.slice(0, loadLimit).map((question) =>
    withoutCategory({ ...question, time: 10 }),
  )

  const bankQuiz = quiz("OpenTriviaQA — ngân hàng câu hỏi", bank)
  const loadQuiz = quiz("OpenTriviaQA — tập đo tải", load)

  for (const [name, doc] of [
    ["bank", bankQuiz],
    ["load", loadQuiz],
  ]) {
    const result = validateRazziaQuiz(doc)

    if (!result.ok) {
      throw new Error(`${name}: ${result.errors.join(" ")}`)
    }
  }

  await mkdir(outDir, { recursive: true })
  await writeFile(
    path.join(outDir, "opentrivia-bank.json"),
    `${JSON.stringify(bankQuiz, null, 2)}\n`,
  )
  await writeFile(
    path.join(outDir, "opentrivia-load.json"),
    `${JSON.stringify(loadQuiz, null, 2)}\n`,
  )

  const manifest = {
    license: LICENSE,
    source: SOURCE_REPO,
    sourceCommit,
    seed,
    categories: sources,
    bankQuestions: bank.length,
    loadQuestions: load.length,
    note: "Tập đo tải bỏ category để mỗi câu đều có màn leaderboard. maxPoints = 1 chỉ là trần điểm của Razzia gốc; điểm theo thời gian vẫn còn cho đến khi vai A sửa scorer.",
  }

  await writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await writeFile(
    path.join(outDir, "ATTRIBUTION.md"),
    attribution(manifest),
  )

  console.log(
    `Wrote ${bank.length} bank + ${load.length} load questions to ${outDir}`,
  )
}

function withoutCategory(question) {
  const { category, ...rest } = question
  return rest
}

function quiz(subject, questions) {
  return {
    gameMode: "quiz",
    subject,
    questions,
  }
}

function attribution(manifest) {
  const rows = manifest.categories
    .map(
      (source) =>
        `| ${source.category} | ${source.parsed} | ${source.kept} | \`${source.sha256.slice(0, 12)}\` |`,
    )
    .join("\n")

  return `# Ghi công câu hỏi

Bộ câu hỏi này được chuyển từ [OpenTriviaQA](${manifest.source}) (commit \`${manifest.sourceCommit}\`).

Tác giả gốc phát hành dữ liệu theo giấy phép **Creative Commons Attribution-ShareAlike 4.0** (CC BY-SA 4.0): https://creativecommons.org/licenses/by-sa/4.0/

Đây là bản chuyển thể: chỉ giữ câu một đáp án đúng, 2–4 lựa chọn, đáp án đúng khớp nguyên văn một lựa chọn. Thứ tự câu được xáo với seed \`${manifest.seed}\`. Khi công bố lại bộ câu hỏi hoặc bản báo cáo có trích câu, phải ghi công OpenTriviaQA và giữ cùng giấy phép CC BY-SA 4.0.

| Category | Câu đọc được | Câu giữ | SHA-256 (12 ký tự) |
| --- | ---: | ---: | --- |
${rows}

Không sửa nội dung câu hỏi ngoài việc chuẩn hoá khoảng trắng ở đầu/cuối dòng.
`
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
