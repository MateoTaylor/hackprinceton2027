// What the score-property subagent hands back. Import it with a relative path:
// `import { PropertyScore } from './contract.ts'`.
import { z } from 'zod'

// What the score-property subagent returns for one property. The `title` names the structured
// output tool; without it the subagent loops instead of answering.
export const PropertyScore = z
  .object({
    propertyId: z.string().describe('The property id, such as commercial-12345'),
    score: z.number().min(0).max(100).describe('0 is unusable for the question, 100 is ideal'),
    summary: z.string().describe('One or two sentences a user can read on the pin'),
    evidence: z
      .array(
        z.object({
          source: z.enum(['costar', 'aerial', 'vexcel', 'scan', 'overture']),
          detail: z.string().describe('What this source showed, specific enough to check'),
        }),
      )
      .describe('One item per signal that moved the score'),
  })
  .meta({ title: 'PropertyScore', description: 'The score and evidence for one property.' })

export type PropertyScore = z.infer<typeof PropertyScore>
