sma(Values, Period, Average) :-
  Period > 0,
  list_length(Values, Length),
  Length >= Period,
  last_n(Values, Period, Window),
  sum_values(Window, Sum),
  Average is Sum / Period.

ema([First|Tail], Period, Average) :-
  Period > 0,
  Alpha is 2 / (Period + 1),
  ema_acc(Tail, Alpha, First, Average).

ema_acc([], _, Accumulator, Accumulator).
ema_acc([Value|Tail], Alpha, Accumulator, Average) :-
  Next is Alpha * Value + (1 - Alpha) * Accumulator,
  ema_acc(Tail, Alpha, Next, Average).

rsi(Closes, Period, Value) :-
  Period > 0,
  deltas(Closes, AllDeltas),
  list_length(AllDeltas, DeltaCount),
  DeltaCount >= Period,
  last_n(AllDeltas, Period, Window),
  split_gains_losses(Window, Gains, Losses),
  sum_values(Gains, GainSum),
  sum_values(Losses, LossSum),
  AverageGain is GainSum / Period,
  AverageLoss is LossSum / Period,
  rsi_value(AverageGain, AverageLoss, Value).

rsi_value(Gain, Loss, 50) :- Gain =:= 0, Loss =:= 0, !.
rsi_value(_, Loss, 100) :- Loss =:= 0, !.
rsi_value(Gain, _, 0) :- Gain =:= 0, !.
rsi_value(Gain, Loss, Value) :-
  Ratio is Gain / Loss,
  Value is 100 - (100 / (1 + Ratio)).

macd(Closes, FastPeriod, SlowPeriod, Value) :-
  ema(Closes, FastPeriod, Fast),
  ema(Closes, SlowPeriod, Slow),
  Value is Fast - Slow.

true_ranges([High|Highs], [Low|Lows], [Close|Closes], [First|Ranges]) :-
  First is High - Low,
  subsequent_ranges(Highs, Lows, Close, Closes, Ranges).

subsequent_ranges([], [], _, [], []).
subsequent_ranges([High|Highs], [Low|Lows], PreviousClose, [Close|Closes], [Range|Ranges]) :-
  Intraday is High - Low,
  HighGapRaw is High - PreviousClose,
  LowGapRaw is Low - PreviousClose,
  abs_value(HighGapRaw, HighGap),
  abs_value(LowGapRaw, LowGap),
  max3(Intraday, HighGap, LowGap, Range),
  subsequent_ranges(Highs, Lows, Close, Closes, Ranges).

atr(Highs, Lows, Closes, Period, Value) :-
  true_ranges(Highs, Lows, Closes, Ranges),
  sma(Ranges, Period, Value).

