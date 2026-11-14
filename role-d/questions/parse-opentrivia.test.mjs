import assert from "node:assert/strict"
import test from "node:test"
import { parseOpenTrivia, toSingleChoice } from "./parse-opentrivia.mjs"
import { validateRazziaQuiz } from "./quiz-schema.mjs"

const SAMPLE = `
#Q Clouds are made up of these.
^ Water droplets and ice crystals
A Carbon atoms
B Water droplets and ice crystals
C Oxygen ions
D Dust mites

#Q Immanuel Kant criticized Emanuel Swedenborg and termed him a “spook hunter”.
^ True
A True
B False

#Q Too many choices.
^ A
A A
B B
C C
D D
E E

#Q Missing correct choice.
^ Nowhere
A Here
B There
`

test("parses OpenTrivia blocks and keeps only MVP questions", () => {
  const parsed = parseOpenTrivia(SAMPLE)
  assert.equal(parsed.length, 4)

  const { questions, skipped } = toSingleChoice(parsed, {
    cooldown: 3,
    time: 10,
    maxPoints: 1,
  })

  assert.equal(questions.length, 2)
  assert.equal(questions[0].solutions[0], 1)
  assert.equal(questions[1].answers.length, 2)
  assert.equal(skipped.tooManyChoices, 1)
  assert.equal(skipped.correctMissing, 1)

  const quiz = validateRazziaQuiz({
    gameMode: "quiz",
    subject: "Sample",
    questions,
  })
  assert.equal(quiz.ok, true)
})

test("rejects a quiz that would not pass Razzia", () => {
  const result = validateRazziaQuiz({
    gameMode: "survey",
    subject: "",
    questions: [
      {
        type: "multi",
        question: "Q",
        answers: ["only-one"],
        solutions: [],
        cooldown: 1,
        time: 1,
      },
    ],
  })

  assert.equal(result.ok, false)
  assert.ok(result.errors.length >= 4)
})
