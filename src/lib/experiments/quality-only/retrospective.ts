/**
 * The six-session retrospective QUALITY_OTHER audit is MOTIVATION ONLY for this
 * prospective epoch. Any reference to it in code/docs must carry this label so
 * it is never accidentally blended into epoch 1's official sample.
 */
export interface RetrospectiveReference {
  retrospectiveDiagnostic: true
  officialEpochContribution: false
  note: string
}

export function retrospectiveMotivationLabel(note: string): RetrospectiveReference {
  return { retrospectiveDiagnostic: true, officialEpochContribution: false, note }
}
