const MAX_SEED = 2_147_483_647;

export function normalizeSeed(seed) {
  const value = typeof seed === 'string' && /^[-+]?\d+$/.test(seed.trim()) ? Number(seed) : seed;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SEED) {
    throw new RangeError(`Seed must be an integer from 1 to ${MAX_SEED}: ${seed}`);
  }
  return value;
}

// Seeded subtractive Random used by the target game's .NET runtime.
export class DotNetRandom {
  constructor(seed) {
    const normalized = normalizeSeed(seed);
    this._mbig = 2_147_483_647;
    this._seedArray = new Array(56).fill(0);

    let mj = (161_803_398 - Math.abs(normalized)) | 0;
    this._seedArray[55] = mj;
    let mk = 1;

    for (let i = 1; i < 55; i += 1) {
      const ii = (21 * i) % 55;
      this._seedArray[ii] = mk;
      mk = (mj - mk) | 0;
      if (mk < 0) mk = (mk + this._mbig) | 0;
      mj = this._seedArray[ii];
    }

    for (let k = 1; k < 5; k += 1) {
      for (let i = 1; i < 56; i += 1) {
        let value = (this._seedArray[i] - this._seedArray[1 + ((i + 30) % 55)]) | 0;
        if (value < 0) value = (value + this._mbig) | 0;
        this._seedArray[i] = value;
      }
    }

    this._inext = 0;
    this._inextp = 21;
  }

  sample() {
    let inext = this._inext + 1;
    if (inext >= 56) inext = 1;
    let inextp = this._inextp + 1;
    if (inextp >= 56) inextp = 1;

    let value = (this._seedArray[inext] - this._seedArray[inextp]) | 0;
    if (value === this._mbig) value -= 1;
    if (value < 0) value = (value + this._mbig) | 0;

    this._seedArray[inext] = value;
    this._inext = inext;
    this._inextp = inextp;
    return value * (1 / this._mbig);
  }

  next(maxValue) {
    if (!Number.isInteger(maxValue) || maxValue <= 0) {
      throw new RangeError(`Random upper bound must be a positive integer: ${maxValue}`);
    }
    return Math.floor(this.sample() * maxValue);
  }

  nextDouble() {
    return this.sample();
  }
}
