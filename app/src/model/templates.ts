// Authored fold steps for the built-in templates, so a fresh document (and
// anything saved from it) already knows how to fold itself — open, press
// play. Each step is a cumulative snapshot of hinge angles.

import { buildPanelTree, type PaperDoc } from './document'
import { newStepId, type Step } from './ops'
import type { Template } from '../state/store'

/** Hinge edge id for each face (via the panel tree), keyed by face name. */
function hingeByFaceName(doc: PaperDoc): Map<string, number> {
  const tree = buildPanelTree(doc)
  const out = new Map<string, number>()
  for (const face of doc.faces) {
    const hinge = tree.nodes.get(face.id)?.hingeEdgeId
    if (hinge !== null && hinge !== undefined) out.set(face.name, hinge)
  }
  return out
}

/**
 * Build the template's fold steps from its target angles: each stage folds
 * the panels whose names match, on top of everything folded so far.
 */
function stagedSteps(doc: PaperDoc, stages: Array<{ name: string; match: RegExp }>): Step[] {
  const hinges = hingeByFaceName(doc)
  const targets = doc.targetAngles ?? {}
  const angles: Record<number, number> = {}
  const steps: Step[] = []
  for (const stage of stages) {
    for (const [faceName, hinge] of hinges) {
      if (!stage.match.test(faceName)) continue
      const t = targets[hinge]
      if (t !== undefined) angles[hinge] = t
    }
    steps.push({ id: newStepId(), name: stage.name, angles: { ...angles } })
  }
  return steps
}

export function templateSteps(template: Template, doc: PaperDoc): Step[] {
  if (template === 'can') {
    // One stage folds every vertical crease to its exterior angle at once,
    // wrapping the flat label strip into a cylinder.
    return stagedSteps(doc, [{ name: 'Roll into a cylinder', match: /panel|seam/ }])
  }
  if (template === 'sleeve') {
    return stagedSteps(doc, [{ name: 'Wrap the sleeve', match: /panel|seam/ }])
  }
  if (template === 'gable') {
    return stagedSteps(doc, [
      { name: 'Fold the body square', match: /^(right side|back|left side|glue flap)$/ },
      { name: 'Close the bottom', match: /bottom flap/ },
      { name: 'Seal the gable top', match: /roof|rib|gusset/ },
    ])
  }
  if (template === 'tuckbox') {
    // Dust flaps first, then the lid over them with its tuck riding along.
    return stagedSteps(doc, [
      { name: 'Fold the body square', match: /^(right side|back|left side|glue flap)$/ },
      { name: 'Bottom: dust flaps in', match: /bottom dust flap/ },
      { name: 'Bottom: close the lid, tuck it in', match: /bottom (lid|tuck)/ },
      { name: 'Top: dust flaps in', match: /top dust flap/ },
      { name: 'Top: close the lid, tuck it in', match: /top (lid|tuck)/ },
    ])
  }
  if (template === 'crossbox') {
    // Sides back and their flaps in, then bottom + back up around them, then
    // the lid over the top dust flaps.
    return stagedSteps(doc, [
      { name: 'Fold the sides back', match: /^(left|right) side$/ },
      { name: 'Side flaps in', match: /side (back flap|bottom dust flap)/ },
      { name: 'Bottom and back up', match: /^(bottom|back|back tab)$/ },
      { name: 'Top: dust flaps in', match: /top dust flap/ },
      { name: 'Top: close the lid, tuck it in', match: /top (lid|tuck)/ },
    ])
  }
  return stagedSteps(doc, [
    { name: 'Fold the body square', match: /^(right side|back|left side|glue flap)$/ },
    { name: 'Close the bottom', match: /bottom flap/ },
    { name: 'Tuck the top', match: /top flap/ },
  ])
}
