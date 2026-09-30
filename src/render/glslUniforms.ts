/**
 * 矩阵 uniform 的布局转换。
 *
 * ⚠️ **这是一个很容易踩的坑。**
 *
 * 项目里的所有 3×3 矩阵（`astro/vec3.ts` 的 `Mat3`）都是**行主序**，
 * 即 `m[r*3+c]` 是第 r 行第 c 列，`mat3Apply(m, v)` 算的是标准的 `M·v`。
 *
 * 但 GLSL 的 `mat3` 是**列主序**：`mat3 m` 中 `m[col][row]`，
 * 把一个长度为 9 的数组直接绑给 `mat3` uniform 时，GLSL 会把前三个元素
 * 当成**第一列**。于是 `M_glsl[i][j] = flat[j*3+i]`，也就是
 * `M_glsl = M_rowmajorᵀ`。
 *
 * 结果就是着色器里执行的是**逆旋转**：星点还能看出是星，但方向全错
 * （最先暴露的现象是地平线跑到了画面侧面而不是下方）。
 *
 * 所以上行主序矩阵前必须经过 `toGlslMat3()` 转置一次。
 * 全项目只有这一处做转换，不要在各个调用点手写。
 */

/** 行主序 3×3 数组 → 可直接绑给 GLSL `mat3` uniform 的列主序数组 */
export function toGlslMat3(rowMajor: ArrayLike<number>): Float32Array {
  if (rowMajor.length !== 9) {
    throw new Error(`toGlslMat3 需要长度 9 的矩阵，收到 ${rowMajor.length}`);
  }
  const out = new Float32Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      // GLSL 的 flat[c*3+r] 对应行主序的 [r*3+c]
      out[c * 3 + r] = rowMajor[r * 3 + c]!;
    }
  }
  return out;
}

/** 把行主序矩阵写进已有的 uniform 数组（避免每帧分配） */
export function writeGlslMat3(target: Float32Array, rowMajor: ArrayLike<number>): void {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      target[c * 3 + r] = rowMajor[r * 3 + c]!;
    }
  }
}

export const IDENTITY_MAT3 = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
