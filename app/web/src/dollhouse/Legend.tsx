import './dollhouse.css'

// Says what the two styles of the dollhouse mean, and how much of the building is inferred.
// `inferredShare` is a fraction from 0 to 1, from `result.inferredShare` of `building_get`.
//   <Legend inferredShare={result.inferredShare} />
export function Legend({ inferredShare }: { inferredShare: number }) {
  return (
    <div className="legend">
      <span className="legend-item">
        <span className="legend-swatch scanned" aria-hidden />
        Scanned
      </span>
      <span className="legend-item">
        <span className="legend-swatch inferred" aria-hidden />
        Inferred
        <span className="legend-share">{Math.round(inferredShare * 100)}% of the building</span>
      </span>
    </div>
  )
}
