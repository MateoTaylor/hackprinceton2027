import './dollhouse.css'

// Says what the two styles of the dollhouse mean.
//   <Legend />
export function Legend() {
  return (
    <div className="legend">
      <span className="legend-item">
        <span className="legend-swatch scanned" aria-hidden />
        Scanned
      </span>
      <span className="legend-item">
        <span className="legend-swatch inferred" aria-hidden />
        Inferred
      </span>
    </div>
  )
}
