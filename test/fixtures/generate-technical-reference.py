"""Offline reference only: TA-Lib Python 0.6.8 / C 0.6.4, default compatibility, unstable=0.
MACD intentionally preserves SETscope's independently seeded EMA convention.
Flat RSI intentionally preserves SETscope's neutral 50 (TA-Lib returns 0).
No production dependency, provider requests, or application imports.
"""
import json
import math
from pathlib import Path
import numpy as np
import talib

assert talib.__version__ == '0.6.8' and talib.__ta_version__.startswith(b'0.6.4 ')
talib.set_compatibility(0)
for name in ['EMA', 'RSI', 'ATR']:
    talib.set_unstable_period(name, 0)

def clean(values):
    return [float(v) if np.isfinite(v) else None for v in values]

cases = []
for mode in ['flat', 'rising', 'falling', 'volatile', 'gap']:
    close = np.array([100 if mode == 'flat' else 50+i*.2 if mode == 'rising' else
        150-i*.2 if mode == 'falling' else 100+7*math.sin(i*.37)+2*math.cos(i*.11)+(15 if mode=='gap' and i>=130 else 0)
        for i in range(260)], dtype=np.float64)
    high, low = close+1.5, close-1.2
    rows = [dict(time=1790000000000+i*60000, open=float(c-.1), high=float(h), low=float(l), close=float(c), volume=1000+i%17*83)
        for i,(c,h,l) in enumerate(zip(close,high,low))]
    fast,slow=talib.EMA(close,12),talib.EMA(close,26)
    macd=fast-slow
    signal=np.full(len(close),np.nan)
    signal[25:]=talib.EMA(macd[25:],9)
    upper,middle,lower=talib.BBANDS(close,20,2,2,0)
    rsi=talib.RSI(close,14)
    if mode=='flat': rsi[14:]=50
    expected=dict(sma20=clean(talib.SMA(close,20)),rsi=clean(rsi),atr=clean(talib.ATR(high,low,close,14)),
        macd=clean(macd),signal=clean(signal),histogram=clean(macd-signal),bb=dict(upper=clean(upper),middle=clean(middle),lower=clean(lower)))
    for period in [20,50,100,200]: expected['ema'+str(period)]=clean(talib.EMA(close,period))
    cases.append(dict(name=mode,rows=rows,expected=expected))
artifact=dict(reference=dict(wrapper=talib.__version__,core=talib.__ta_version__.decode(),compatibility=0,unstable=0,
    bb='population SD, SMA20, 2 deviations',macd='EMA12 independently seeded minus EMA26, EMA9 of valid MACD',flatRsi=50),cases=cases)
Path(__file__).with_name('technical-reference.json').write_text(json.dumps(artifact,separators=(',',':'),allow_nan=False)+'\n',encoding='utf-8')
