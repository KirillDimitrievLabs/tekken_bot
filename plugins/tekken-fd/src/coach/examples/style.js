// Synthetic writing templates only. No character facts or human review claims.
export const COUNTER_STYLE = JSON.stringify({
  defense: [{ situation: "After blocking [[OPPONENT_EVIDENCED_STRING]]", answer: "Use the escape supported by that string's dossier entry; wait for the follow-up to whiff.", reward: "A punish opportunity instead of gambling during pressure." }],
  lab_drill: ["Record [[OPPONENT_EVIDENCED_STRING]] and its stop option. Shuffle the recordings; practice the supported escape, then punish the whiff."],
});
export const MATCHUP_STYLE = JSON.stringify({
  punish: [{ move: "[[OPPONENT_EVIDENCED_UNSAFE]]", answer: "[[YOUR_COMPUTED_PUNISH]]", note: "Practice after blocking at different spacings; frame eligibility alone does not guarantee reach." }],
  stop_doing: [{ move: "[[YOUR_EVIDENCED_UNSAFE]]", why: "The reverse punish table gives [[OPPONENT_COMPUTED_PUNISH]]; use the supported safe alternative at this range." }],
});
