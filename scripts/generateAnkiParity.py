"""Generate synthetic expected states with the official Anki 26.9.3 backend.

Run with an isolated Python environment containing anki==26.9.3. No personal
collection is opened. Run once normally and once with --no-fuzz.
"""
import argparse, json, os, tempfile, time, copy
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("--no-fuzz", action="store_true")
args = parser.parse_args()
if args.no_fuzz:
    os.environ["ANKI_TEST_MODE"] = "1"
else:
    os.environ.pop("ANKI_TEST_MODE", None)

from anki.collection import Collection
from anki.scheduler_pb2 import CardAnswer
from google.protobuf.json_format import MessageToDict
from importlib.metadata import version
assert version("anki") == "26.9.3"

def normalized(state):
    n = state.get("normal") or state["filtered"]["rescheduling"]["original_state"]
    phase = next(iter(n))
    data = n[phase]
    review = data.get("review", data) if phase in ("review", "relearning") else {}
    learning = data.get("learning", data) if phase in ("learning", "relearning") else {}
    return {"phase": phase.upper(), "remainingSteps": learning.get("remaining_steps", 0),
            "scheduledSeconds": learning.get("scheduled_secs", 0),
            "interval": review.get("scheduled_days", 0),
            "ease": review.get("ease_factor", 2.5), "lapses": review.get("lapses", 0)}

cases = []
with tempfile.TemporaryDirectory() as folder:
    col = Collection(folder + "/synthetic.anki2")
    col.set_config("fsrs", False)
    col.set_config("loadBalancerEnabled", False)
    col.set_config("rollover", 4)
    col.set_config("localOffset", -int(datetime.now(ZoneInfo("Europe/Berlin")).utcoffset().total_seconds() / 60))
    note = col.new_note(col.models.by_name("Basic"))
    note.fields[0], note.fields[1] = "Synthetic parity test", "Answer"
    col.add_note(note, 1)
    cid = note.cards()[0].id
    # A stable identity also makes the reference backend's fuzz reproducible.
    col.db.execute("update cards set id=? where id=?", 1790000000000, cid)
    cid = 1790000000000
    filtered_id = col.decks.new_filtered("Synthetic early practice")
    configurations = [([1, 10], [10], 1, 4, 1, 1.2, 1.3, 0, 36500),
                      ([10, 720], [1440], 3, 5, 1, 1.2, 1.3, 0, 36500),
                      ([], [], 2, 5, 0.8, 1, 1.5, 0.2, 365),
                      ([30, 1440, 4320], [10, 1440], 4, 7, 1.1, 1.3, 1.4, 0.3, 2000)]
    for steps, relearn, good, easy, modifier, hard_factor, easy_factor, lapse_factor, maximum in configurations:
        conf = col.decks.get_config(1)
        conf["new"].update(delays=steps, ints=[good, easy, 0])
        conf["lapse"].update(delays=relearn, mult=lapse_factor)
        conf["rev"].update(ivlFct=modifier, hardFactor=hard_factor, ease4=easy_factor, maxIvl=maximum)
        col.decks.update_config(conf)
        options = {"learningSteps": steps, "relearningSteps": relearn, "graduatingGood": good,
                   "graduatingEasy": easy, "intervalMultiplier": modifier, "hardMultiplier": hard_factor,
                   "easyMultiplier": easy_factor, "lapseMultiplier": lapse_factor, "maximumInterval": maximum}
        inputs = [(0, 0, 0, 0, 0, 2.5)]
        inputs += [(1, queue, remaining, 0, 0, 2.5) for queue in [1, 3] for remaining in [0, 1, 2, 3, 1002]]
        inputs += [(2, 2, 0, interval, late, ease) for interval in [1, 5, 100, 942]
                   for late in [-3, 0, 11] for ease in [1.3, 2.5, 2.95]]
        inputs += [(3, queue, remaining, 20, 0, 2.3) for queue in [1, 3] for remaining in [1, 2]]
        inputs = [(entry, False) for entry in inputs] + [(entry, True) for entry in inputs if entry[0] == 2 and entry[4] < 0]
        for number, ((kind, queue, remaining, interval, late, ease), early) in enumerate(inputs):
            card = col.get_card(cid)
            card.type, card.queue, card.left = kind, queue, remaining
            card.did, card.odid, card.odue = (filtered_id, 1, col.sched.today - late) if early else (1, 0, 0)
            card.ivl, card.factor, card.reps, card.lapses = interval, round(ease * 1000), number + 7, 2 if kind in [2, 3] else 0
            card.due = col.sched.today - late if queue in [2, 3] else 1790000000 if queue == 1 else 1
            if early: card.due = -1000
            card.data = ""
            col.update_card(card)
            states = MessageToDict(col._backend.get_scheduling_states(cid), preserving_proto_field_name=True)
            current = normalized(states["current"])
            current_normal = states["current"].get("normal") or states["current"]["filtered"]["rescheduling"]["original_state"]
            review = current_normal.get("review", {})
            current["elapsedDays"] = review.get("elapsed_days", 0)
            applied = []
            original = copy.copy(card)
            for rating in [CardAnswer.AGAIN, CardAnswer.HARD, CardAnswer.GOOD, CardAnswer.EASY]:
                col.update_card(original)
                card = col.get_card(cid)
                card.start_timer()
                choices = col._backend.get_scheduling_states(cid)
                before = int(time.time())
                col.sched.answer_card(col.sched.build_answer(card=card, states=choices, rating=rating))
                after = col.get_card(cid)
                applied.append({"now": before * 1000, "tolerance": int(time.time()) - before,
                    "queue": after.queue, "due": after.due, "today": col.sched.today,
                    "remainingSteps": after.left % 1000, "lapses": after.lapses, "reps": after.reps})
            cases.append({"earlyReview": early, "applied": applied, "input": current, "options": options, "cardId": str(cid), "reps": original.reps,
                          "expected": [normalized(states[k]) for k in ["again", "hard", "good", "easy"]]})
    col.close()
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({"ankiVersion": version("anki"), "fuzz": not args.no_fuzz, "cases": cases}, indent=2) + "\n")
print(f"Generated {len(cases)} synthetic cases ({len(cases)*4} answers), fuzz={not args.no_fuzz}")
