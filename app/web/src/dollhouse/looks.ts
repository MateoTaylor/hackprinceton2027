// The dollhouse's one look: a true isometric camera and the colours of every surface it draws.
export const DEFAULT_LOOK = {
  id: 'default',
  label: 'Isometric',
  elevationDeg: 35.264,
  azimuthDeg: 45,
  wallStubM: 0.3,
  roughness: 0.9,
  palette: {
    background: '#0E0F11',
    outline: '#A1A7AE',
    wall: '#E6E4DE',
    cut: '#2A2D32',
    accent: '#3D8BDB',
    floors: {
      work: '#D2B77C',
      meet: '#6F9BC0',
      living: '#C98A6B',
      wet: '#63B3A4',
      circulation: '#B9AE9E',
      storage: '#9C8AB8',
      other: '#A8B37A',
    },
    furniture: {
      wood: '#B58A5E',
      fabric: '#5E86B5',
      metal: '#9AA3AD',
      white: '#E6E4DE',
      green: '#6FA06B',
    },
    proto: {
      high: { fill: '#565B63', line: '#8B929B' },
      mid: { fill: '#43474E', line: '#6B717A' },
      low: { fill: '#32353A', line: '#50555C' },
      context: { fill: '#1F2226', line: '#2A2D32' },
    },
  },
}

export type Look = typeof DEFAULT_LOOK
export type FloorTone = keyof Look['palette']['floors']
export type FurnitureTone = keyof Look['palette']['furniture']
export type ProtoTone = keyof Look['palette']['proto']
