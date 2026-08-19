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

first_value([Value|_], Value).
last_value([Value], Value).
last_value([_|Tail], Value) :- last_value(Tail, Value).

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

sum_squared_deviations([], _, 0).
sum_squared_deviations([Value|Tail], Mean, Sum) :-
  Difference is Value - Mean,
  sum_squared_deviations(Tail, Mean, TailSum),
  Sum is Difference * Difference + TailSum.

sum_indexed_products(Values, Sum) :-
  sum_indexed_products_acc(Values, 0, 0, Sum).
sum_indexed_products_acc([], _, Accumulator, Accumulator).
sum_indexed_products_acc([Value|Tail], Index, Accumulator, Sum) :-
  NextAccumulator is Accumulator + Index * Value,
  NextIndex is Index + 1,
  sum_indexed_products_acc(Tail, NextIndex, NextAccumulator, Sum).

weighted_sums([], [], 0, 0).
weighted_sums([Value|Values], [Weight|Weights], WeightedSum, WeightSum) :-
  weighted_sums(Values, Weights, TailWeightedSum, TailWeightSum),
  WeightedSum is Value * Weight + TailWeightedSum,
  WeightSum is Weight + TailWeightSum.

max_list_value([Value|Tail], Maximum) :- max_list_acc(Tail, Value, Maximum).
max_list_acc([], Accumulator, Accumulator).
max_list_acc([Value|Tail], Accumulator, Maximum) :-
  max_value(Value, Accumulator, Next),
  max_list_acc(Tail, Next, Maximum).

min_list_value([Value|Tail], Minimum) :- min_list_acc(Tail, Value, Minimum).
min_list_acc([], Accumulator, Accumulator).
min_list_acc([Value|Tail], Accumulator, Minimum) :-
  Value < Accumulator,
  !,
  min_list_acc(Tail, Value, Minimum).
min_list_acc([_|Tail], Accumulator, Minimum) :-
  min_list_acc(Tail, Accumulator, Minimum).
