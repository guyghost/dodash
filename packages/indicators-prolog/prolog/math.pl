abs_value(Value, Absolute) :-
  Value >= 0,
  Absolute is Value.
abs_value(Value, Absolute) :-
  Value < 0,
  Absolute is -Value.

max_value(A, B, A) :- A >= B.
max_value(A, B, B) :- A < B.

max3(A, B, C, Maximum) :-
  max_value(A, B, Partial),
  max_value(Partial, C, Maximum).

