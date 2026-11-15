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

true_range(High, Low, PreviousClose, Range) :-
  Intraday is High - Low,
  HighGapRaw is High - PreviousClose,
  LowGapRaw is Low - PreviousClose,
  abs_value(HighGapRaw, HighGap),
  abs_value(LowGapRaw, LowGap),
  max3(Intraday, HighGap, LowGap, Range).

atr_seed(Highs, Lows, Closes, 0, PreviousClose, Sum, Sum, Highs, Lows, Closes, PreviousClose).
atr_seed([High|Highs], [Low|Lows], [Close|Closes], Count, PreviousClose, Accumulator, Sum, RemainingHighs, RemainingLows, RemainingCloses, LastClose) :-
  Count > 0,
  true_range(High, Low, PreviousClose, Range),
  NextAccumulator is Accumulator + Range,
  NextCount is Count - 1,
  atr_seed(Highs, Lows, Closes, NextCount, Close, NextAccumulator, Sum, RemainingHighs, RemainingLows, RemainingCloses, LastClose).

atr_continue([], [], [], _, _, Accumulator, Accumulator).
atr_continue([High|Highs], [Low|Lows], [Close|Closes], PreviousClose, Period, Accumulator, Value) :-
  true_range(High, Low, PreviousClose, Range),
  Next is (Accumulator * (Period - 1) + Range) / Period,
  atr_continue(Highs, Lows, Closes, Close, Period, Next, Value).

atr([High|Highs], [Low|Lows], [Close|Closes], Period, Value) :-
  Period > 0,
  FirstRange is High - Low,
  RemainingSeedCount is Period - 1,
  atr_seed(Highs, Lows, Closes, RemainingSeedCount, Close, FirstRange, SeedSum, RemainingHighs, RemainingLows, RemainingCloses, PreviousClose),
  Seed is SeedSum / Period,
  atr_continue(RemainingHighs, RemainingLows, RemainingCloses, PreviousClose, Period, Seed, Value).

log_returns([_], []).
log_returns([First, Second|Tail], [Return|Returns]) :-
  Ratio is Second / First,
  Return is log(Ratio),
  log_returns([Second|Tail], Returns).

sample_standard_deviation(Values, Value) :-
  list_length(Values, Length),
  Length >= 2,
  sum_values(Values, Sum),
  Mean is Sum / Length,
  sum_squared_deviations(Values, Mean, SquaredSum),
  Variance is SquaredSum / (Length - 1),
  Value is sqrt(Variance).

historical_volatility(Closes, Period, Value) :-
  Period >= 2,
  log_returns(Closes, Returns),
  list_length(Returns, Count),
  Count >= Period,
  last_n(Returns, Period, Window),
  sample_standard_deviation(Window, Value).

momentum(Closes, Period, Value) :-
  WindowLength is Period + 1,
  last_n(Closes, WindowLength, Window),
  first_value(Window, Reference),
  last_value(Window, Current),
  Value is Current - Reference.

periodic_return(Closes, Period, Value) :-
  WindowLength is Period + 1,
  last_n(Closes, WindowLength, Window),
  first_value(Window, Reference),
  last_value(Window, Current),
  Value is Current / Reference - 1.

typical_weighted_sums([], [], [], [], 0, 0).
typical_weighted_sums([High|Highs], [Low|Lows], [Close|Closes], [Volume|Volumes], WeightedSum, VolumeSum) :-
  Typical is (High + Low + Close) / 3,
  typical_weighted_sums(Highs, Lows, Closes, Volumes, TailWeightedSum, TailVolumeSum),
  WeightedSum is Typical * Volume + TailWeightedSum,
  VolumeSum is Volume + TailVolumeSum.

ohlcv_vwap(Highs, Lows, Closes, Volumes, Period, Value) :-
  last_n(Highs, Period, HighWindow),
  last_n(Lows, Period, LowWindow),
  last_n(Closes, Period, CloseWindow),
  last_n(Volumes, Period, VolumeWindow),
  typical_weighted_sums(HighWindow, LowWindow, CloseWindow, VolumeWindow, WeightedSum, VolumeSum),
  VolumeSum > 0,
  Value is WeightedSum / VolumeSum.

weighted_vwap(Prices, Sizes, Value) :-
  weighted_sums(Prices, Sizes, WeightedSum, SizeSum),
  SizeSum > 0,
  Value is WeightedSum / SizeSum.

relative_volume(Volumes, Period, Value) :-
  WindowLength is Period + 1,
  last_n(Volumes, WindowLength, Window),
  take_n(Period, Window, ReferenceWindow),
  last_value(Window, Current),
  sum_values(ReferenceWindow, ReferenceSum),
  ReferenceSum > 0,
  ReferenceAverage is ReferenceSum / Period,
  Value is Current / ReferenceAverage.

volume_spike(RelativeVolume, Threshold, 1) :- RelativeVolume >= Threshold, !.
volume_spike(_, _, 0).

normalized_linear_slope(Values, Value) :-
  list_length(Values, Length),
  Length >= 2,
  sum_values(Values, SumY),
  SumY > 0,
  sum_indexed_products(Values, SumXY),
  SumX is Length * (Length - 1) / 2,
  SumX2 is Length * (Length - 1) * (2 * Length - 1) / 6,
  Denominator is Length * SumX2 - SumX * SumX,
  Slope is (Length * SumXY - SumX * SumY) / Denominator,
  Mean is SumY / Length,
  Value is Slope / Mean.

volume_trend(Volumes, Period, Value) :-
  last_n(Volumes, Period, Window),
  normalized_linear_slope(Window, Value).

vwap_deviation(Current, Vwap, Value) :-
  Vwap > 0,
  Value is Current / Vwap - 1.

directional_values(UpMove, DownMove, UpMove, 0) :-
  UpMove > DownMove,
  UpMove > 0,
  !.
directional_values(UpMove, DownMove, 0, DownMove) :-
  DownMove > UpMove,
  DownMove > 0,
  !.
directional_values(_, _, 0, 0).

directional_step(PreviousHigh, PreviousLow, PreviousClose, High, Low, Range, Plus, Minus) :-
  true_range(High, Low, PreviousClose, Range),
  UpMove is High - PreviousHigh,
  DownMove is PreviousLow - Low,
  directional_values(UpMove, DownMove, Plus, Minus).

dx_value(TrueRange, _, _, 0) :- TrueRange =:= 0, !.
dx_value(_, Plus, Minus, 0) :-
  DirectionalSum is Plus + Minus,
  DirectionalSum =:= 0,
  !.
dx_value(TrueRange, Plus, Minus, Value) :-
  PlusIndex is 100 * Plus / TrueRange,
  MinusIndex is 100 * Minus / TrueRange,
  DifferenceRaw is PlusIndex - MinusIndex,
  abs_value(DifferenceRaw, Difference),
  Value is 100 * Difference / (PlusIndex + MinusIndex).

adx_directional_seed(Highs, Lows, Closes, 0, PreviousHigh, PreviousLow, PreviousClose, RangeSum, PlusSum, MinusSum, Highs, Lows, Closes, PreviousHigh, PreviousLow, PreviousClose, RangeSum, PlusSum, MinusSum).
adx_directional_seed([High|Highs], [Low|Lows], [Close|Closes], Count, PreviousHigh, PreviousLow, PreviousClose, RangeAccumulator, PlusAccumulator, MinusAccumulator, RemainingHighs, RemainingLows, RemainingCloses, LastHigh, LastLow, LastClose, RangeSum, PlusSum, MinusSum) :-
  Count > 0,
  directional_step(PreviousHigh, PreviousLow, PreviousClose, High, Low, Range, Plus, Minus),
  NextCount is Count - 1,
  NextRangeAccumulator is RangeAccumulator + Range,
  NextPlusAccumulator is PlusAccumulator + Plus,
  NextMinusAccumulator is MinusAccumulator + Minus,
  adx_directional_seed(Highs, Lows, Closes, NextCount, High, Low, Close, NextRangeAccumulator, NextPlusAccumulator, NextMinusAccumulator, RemainingHighs, RemainingLows, RemainingCloses, LastHigh, LastLow, LastClose, RangeSum, PlusSum, MinusSum).

adx_dx_seed(Highs, Lows, Closes, 0, PreviousHigh, PreviousLow, PreviousClose, _, SmoothedRange, SmoothedPlus, SmoothedMinus, DxSum, Highs, Lows, Closes, PreviousHigh, PreviousLow, PreviousClose, SmoothedRange, SmoothedPlus, SmoothedMinus, DxSum).
adx_dx_seed([High|Highs], [Low|Lows], [Close|Closes], Count, PreviousHigh, PreviousLow, PreviousClose, Period, SmoothedRange, SmoothedPlus, SmoothedMinus, DxAccumulator, RemainingHighs, RemainingLows, RemainingCloses, LastHigh, LastLow, LastClose, FinalRange, FinalPlus, FinalMinus, DxSum) :-
  Count > 0,
  directional_step(PreviousHigh, PreviousLow, PreviousClose, High, Low, Range, Plus, Minus),
  NextRange is (SmoothedRange * (Period - 1) + Range) / Period,
  NextPlus is (SmoothedPlus * (Period - 1) + Plus) / Period,
  NextMinus is (SmoothedMinus * (Period - 1) + Minus) / Period,
  dx_value(NextRange, NextPlus, NextMinus, DirectionalIndex),
  NextDxAccumulator is DxAccumulator + DirectionalIndex,
  NextCount is Count - 1,
  adx_dx_seed(Highs, Lows, Closes, NextCount, High, Low, Close, Period, NextRange, NextPlus, NextMinus, NextDxAccumulator, RemainingHighs, RemainingLows, RemainingCloses, LastHigh, LastLow, LastClose, FinalRange, FinalPlus, FinalMinus, DxSum).

adx_continue([], [], [], _, _, _, _, _, _, _, Accumulator, Accumulator).
adx_continue([High|Highs], [Low|Lows], [Close|Closes], PreviousHigh, PreviousLow, PreviousClose, Period, SmoothedRange, SmoothedPlus, SmoothedMinus, Accumulator, Value) :-
  directional_step(PreviousHigh, PreviousLow, PreviousClose, High, Low, Range, Plus, Minus),
  NextRange is (SmoothedRange * (Period - 1) + Range) / Period,
  NextPlus is (SmoothedPlus * (Period - 1) + Plus) / Period,
  NextMinus is (SmoothedMinus * (Period - 1) + Minus) / Period,
  dx_value(NextRange, NextPlus, NextMinus, DirectionalIndex),
  Next is (Accumulator * (Period - 1) + DirectionalIndex) / Period,
  adx_continue(Highs, Lows, Closes, High, Low, Close, Period, NextRange, NextPlus, NextMinus, Next, Value).

trend_strength([High|Highs], [Low|Lows], [Close|Closes], Period, Value) :-
  Period > 0,
  adx_directional_seed(Highs, Lows, Closes, Period, High, Low, Close, 0, 0, 0, SeedHighs, SeedLows, SeedCloses, SeedHigh, SeedLow, SeedClose, RangeSum, PlusSum, MinusSum),
  SmoothedRange is RangeSum / Period,
  SmoothedPlus is PlusSum / Period,
  SmoothedMinus is MinusSum / Period,
  dx_value(SmoothedRange, SmoothedPlus, SmoothedMinus, FirstDirectionalIndex),
  RemainingDxCount is Period - 1,
  adx_dx_seed(SeedHighs, SeedLows, SeedCloses, RemainingDxCount, SeedHigh, SeedLow, SeedClose, Period, SmoothedRange, SmoothedPlus, SmoothedMinus, FirstDirectionalIndex, RemainingHighs, RemainingLows, RemainingCloses, PreviousHigh, PreviousLow, PreviousClose, FinalRange, FinalPlus, FinalMinus, DxSum),
  AdxSeed is DxSum / Period,
  adx_continue(RemainingHighs, RemainingLows, RemainingCloses, PreviousHigh, PreviousLow, PreviousClose, Period, FinalRange, FinalPlus, FinalMinus, AdxSeed, Value).

funding_average(FundingRates, Period, Value) :-
  Period >= 2,
  sma(FundingRates, Period, Value).

midpoint(A, B, Value) :- Value is (A + B) / 2.

spread_absolute(Bids, Asks, Value) :-
  max_list_value(Bids, BestBid),
  min_list_value(Asks, BestAsk),
  Value is BestAsk - BestBid.

spread_bps(Bids, Asks, Value) :-
  max_list_value(Bids, BestBid),
  min_list_value(Asks, BestAsk),
  Midpoint is (BestBid + BestAsk) / 2,
  Value is (BestAsk - BestBid) / Midpoint * 10000.
