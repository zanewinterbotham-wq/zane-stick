// Compact CMA-ES (Hansen, "The CMA Evolution Strategy: A Tutorial"), minimisation.
export class CMAES {
  readonly n: number; readonly lambda: number; readonly mu: number;
  mean: number[]; sigma: number;
  private w: number[]; private mueff: number;
  private cc: number; private cs: number; private c1: number; private cmu: number; private damps: number; private chiN: number;
  private pc: number[]; private ps: number[]; private C: number[][]; private B: number[][]; private D: number[];
  private gen = 0;
  constructor(x0: number[], sigma0: number, lambda?: number, private rand: () => number = Math.random) {
    const n = (this.n = x0.length);
    this.lambda = lambda ?? 4 + Math.floor(3 * Math.log(n));
    this.mu = Math.floor(this.lambda / 2);
    const raw = Array.from({ length: this.mu }, (_, i) => Math.log(this.mu + 0.5) - Math.log(i + 1));
    const sw = raw.reduce((a, b) => a + b, 0);
    this.w = raw.map((x) => x / sw);
    this.mueff = 1 / this.w.reduce((a, b) => a + b * b, 0);
    this.cc = (4 + this.mueff / n) / (n + 4 + 2 * this.mueff / n);
    this.cs = (this.mueff + 2) / (n + this.mueff + 5);
    this.c1 = 2 / ((n + 1.3) ** 2 + this.mueff);
    this.cmu = Math.min(1 - this.c1, 2 * (this.mueff - 2 + 1 / this.mueff) / ((n + 2) ** 2 + this.mueff));
    this.damps = 1 + 2 * Math.max(0, Math.sqrt((this.mueff - 1) / (n + 1)) - 1) + this.cs;
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this.mean = x0.slice(); this.sigma = sigma0;
    this.pc = new Array(n).fill(0); this.ps = new Array(n).fill(0);
    this.C = eye(n); this.B = eye(n); this.D = new Array(n).fill(1);
  }
  private gauss() { let u = 0, v = 0; while (u === 0) u = this.rand(); v = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  ask(): number[][] {
    return Array.from({ length: this.lambda }, () => {
      const z = Array.from({ length: this.n }, () => this.gauss());
      const y = this.B.map((row) => row.reduce((a, b, j) => a + b * this.D[j] * z[j], 0));
      return this.mean.map((m, i) => m + this.sigma * y[i]);
    });
  }
  tell(xs: number[][], fs: number[]) {
    const n = this.n, idx = fs.map((f, i) => [f, i]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    const old = this.mean.slice();
    this.mean = new Array(n).fill(0);
    for (let k = 0; k < this.mu; k++) for (let i = 0; i < n; i++) this.mean[i] += this.w[k] * xs[idx[k]][i];
    const ydiff = this.mean.map((m, i) => (m - old[i]) / this.sigma);
    // C^{-1/2} * ydiff = B D^{-1} B^T ydiff
    const bt = this.B[0].map((_, j) => this.B.reduce((a, row, i) => a + row[j] * ydiff[i], 0));
    const invs = this.B.map((row) => row.reduce((a, b, j) => a + b * bt[j] / this.D[j], 0));
    this.ps = this.ps.map((p, i) => (1 - this.cs) * p + Math.sqrt(this.cs * (2 - this.cs) * this.mueff) * invs[i]);
    const psn = Math.hypot(...this.ps);
    this.gen++;
    const hsig: number = psn / Math.sqrt(1 - (1 - this.cs) ** (2 * this.gen)) / this.chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    this.pc = this.pc.map((p, i) => (1 - this.cc) * p + hsig * Math.sqrt(this.cc * (2 - this.cc) * this.mueff) * ydiff[i]);
    const artmp = Array.from({ length: this.mu }, (_, k) => xs[idx[k]].map((x, i) => (x - old[i]) / this.sigma));
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let rankmu = 0;
      for (let k = 0; k < this.mu; k++) rankmu += this.w[k] * artmp[k][i] * artmp[k][j];
      const v = (1 - this.c1 - this.cmu) * this.C[i][j] + this.c1 * (this.pc[i] * this.pc[j] + (1 - hsig) * this.cc * (2 - this.cc) * this.C[i][j]) + this.cmu * rankmu;
      this.C[i][j] = this.C[j][i] = v;
    }
    this.sigma *= Math.exp((this.cs / this.damps) * (psn / this.chiN - 1));
    const { vectors, values } = jacobiEigen(this.C);
    this.B = vectors; this.D = values.map((v) => Math.sqrt(Math.max(1e-20, v)));
  }
}

const eye = (n: number): number[][] => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j): number => (i === j ? 1 : 0)));

/** Symmetric eigendecomposition by cyclic Jacobi rotations. vectors[i][k] = component i of eigenvector k. */
export function jacobiEigen(A0: number[][]) {
  const n = A0.length, A = A0.map((r) => r.slice()), V = eye(n);
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: A.map((r, i) => r[i]), vectors: V };
}
