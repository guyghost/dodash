list_length([], 0).
list_length([_|Tail], Length) :-
  list_length(Tail, TailLength),
  Length is TailLength + 1.

sum_values([], 0).
sum_values([Value|Tail], Sum) :-
  sum_values(Tail, TailSum),
  Sum is Value + TailSum.

reverse_list(List, Reversed) :- reverse_acc(List, [], Reversed).
reverse_acc([], Accumulator, Accumulator).
reverse_acc([Head|Tail], Accumulator, Reversed) :-
  reverse_acc(Tail, [Head|Accumulator], Reversed).

take_n(0, _, []).
take_n(Count, [Head|Tail], [Head|Taken]) :-
  Count > 0,
  NextCount is Count - 1,
  take_n(NextCount, Tail, Taken).

last_n(List, Count, Last) :-
  reverse_list(List, Reversed),
  take_n(Count, Reversed, TakenReversed),
  reverse_list(TakenReversed, Last).

deltas([_], []).
deltas([First, Second|Tail], [Delta|Deltas]) :-
  Delta is Second - First,
  deltas([Second|Tail], Deltas).

split_gains_losses([], [], []).
split_gains_losses([Delta|Tail], [Gain|Gains], [Loss|Losses]) :-
  Delta >= 0,
  Gain is Delta,
  Loss is 0,
  split_gains_losses(Tail, Gains, Losses).
split_gains_losses([Delta|Tail], [Gain|Gains], [Loss|Losses]) :-
  Delta < 0,
  Gain is 0,
  Loss is -Delta,
  split_gains_losses(Tail, Gains, Losses).

