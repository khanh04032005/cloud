/** OpenTriviaQA text format (uberspot/OpenTriviaQA, CC BY-SA 4.0):
 *
 *   #Q question text
 *   ^ correct answer text
 *   A first choice
 *   B second choice
 */

const CHOICE = /^([A-H])\s+(.*)$/

export function parseOpenTrivia(text) {
  const questions = []
  let current = null

  const finish = () => {
    if (!current) {
      return
    }

    questions.push(current)
    current = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()

    if (line === "") {
      finish()
      continue
    }

    if (line.startsWith("#Q")) {
      finish()
      current = {
        question: line.slice(2).trim(),
        correct: "",
        choices: [],
      }
      continue
    }

    if (!current) {
      continue
    }

    if (line.startsWith("^")) {
      current.correct = line.slice(1).trim()
      continue
    }

    const choice = CHOICE.exec(line)

    if (choice) {
      current.choices.push(choice[2].trim())
      continue
    }

    if (!current.correct && current.choices.length === 0) {
      current.question = `${current.question} ${line}`.trim()
    }
  }

  finish()
  return questions
}

export function toSingleChoice(parsed, { cooldown, time, maxPoints }) {
  const skipped = {
    tooFewChoices: 0,
    tooManyChoices: 0,
    empty: 0,
    correctMissing: 0,
    correctAmbiguous: 0,
    duplicateChoice: 0,
  }
  const questions = []

  for (const item of parsed) {
    const prompt = item.question?.trim() ?? ""
    const choices = item.choices.map((choice) => choice.trim()).filter(Boolean)
    const correct = item.correct?.trim() ?? ""

    if (!prompt || !correct) {
      skipped.empty += 1
      continue
    }

    if (choices.length < 2) {
      skipped.tooFewChoices += 1
      continue
    }

    if (choices.length > 4) {
      skipped.tooManyChoices += 1
      continue
    }

    const folded = new Set(choices.map((choice) => choice.toLowerCase()))

    if (folded.size !== choices.length) {
      skipped.duplicateChoice += 1
      continue
    }

    const matches = []

    choices.forEach((choice, index) => {
      if (choice === correct) {
        matches.push(index)
      }
    })

    if (matches.length === 0) {
      skipped.correctMissing += 1
      continue
    }

    if (matches.length > 1) {
      skipped.correctAmbiguous += 1
      continue
    }

    questions.push({
      type: "single",
      question: prompt,
      answers: choices,
      solutions: matches,
      cooldown,
      time,
      maxPoints,
    })
  }

  return { questions, skipped }
}
