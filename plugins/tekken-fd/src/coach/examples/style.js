// Synthetic writing templates only. No character facts or human review claims.
export const COUNTER_STYLE = JSON.stringify({
  defense: [{ situation: "After blocking [[OPPONENT_EVIDENCED_STRING]]", answer: "Use the escape supported by that string's dossier entry; wait for the follow-up to whiff.", reward: "A punish opportunity instead of gambling during pressure." }],
  lab_drill: [{ title: "Escape the string", setup: "Dummy: the opponent character. Record [[OPPONENT_EVIDENCED_STRING]] and its stop option as two recordings, playback random.",
    steps: ["Block the first hit and watch for the follow-up.", "Use the supported escape when the follow-up comes out.", "Punish when they stop early instead."], goal: "You react correctly to both recordings most of the time." }],
});
export const MATCHUP_STYLE = JSON.stringify({
  punish: [{ move: "[[OPPONENT_EVIDENCED_UNSAFE]]", answer: "[[YOUR_COMPUTED_PUNISH]]", note: "Standing punish; use it every time they finish the string." }],
  stop_doing: [{ move: "[[YOUR_EVIDENCED_UNSAFE]]", why: "The reverse punish table gives [[OPPONENT_COMPUTED_PUNISH]]; use the supported safe alternative at this range." }],
});
