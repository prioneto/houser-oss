import { useEffect, useRef } from 'react'
import 'maplibre-gl/dist/maplibre-gl.css'
import { AttributionControl, Map as MapLibre, Marker, NavigationControl, Popup, setWorkerUrl, type ExpressionSpecification, type FilterSpecification, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl'
import type { Feature, FeatureCollection, Geometry, Polygon } from 'geojson'
import { circle, cityView, loadedArea, type Bounds } from './geo'
import { initials, money, textOn } from './format'
import { placeCategories, type PlaceCategory, type ReachMinutes } from './layers'
import { OTHER_CHAIN, type ChainMarker } from './access'
// MapLibre 6 looks for its worker beside its own module, which a Vite build does not emit; bundle it and say where.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { Coordinates, Listing, ParkPolygon, Place, ReachArea, Route, TransitData, TransitMode } from './types'

setWorkerUrl(workerUrl)

type Theme = 'light' | 'dark'
const STYLES: Record<Theme, string> = { light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark' }
const COLORS = {
  light: { ink: '#1b1a17', paper: '#fffdf8', accent: '#d9442a', saved: '#2f7d4f', veil: '#f3efe6', park: '#9dc48a', label: '#1b1a17', halo: '#fffdf8' },
  dark: { ink: '#f1ede4', paper: '#1b1a17', accent: '#ff6a4d', saved: '#5fbf85', veil: '#0c0c0b', park: '#3f6b3a', label: '#f1ede4', halo: '#1b1a17' },
}
const RING_MINUTES = [5, 10]
const RING_KM = (minutes: number) => minutes / 60 * 4.8 / 1.25
const collection = <G extends Geometry>(features: Feature<G>[] = []): FeatureCollection<G> => ({ type: 'FeatureCollection', features })
const HOME_LAYERS = ['home-focus', 'home-pins']
const INTERACTIVE = [...HOME_LAYERS, 'home-clusters', 'daily-dots', 'stops-rail', 'stops-bus', 'transit', 'places-near', 'places']

export interface MapViewProps {
  theme: Theme
  city: Place
  listings: Listing[]
  savedIds: Set<string>
  selected: Listing | null
  hoverId: string | null
  anchor: Place | null
  reach: ReachArea | null
  minutes: ReachMinutes
  route: Route | null
  transit: TransitData | null
  dailyPlaces: ChainMarker[]
  parks: ParkPolygon[] | null
  lineModes: TransitMode[]
  places: PlaceCategory[]
  lineFilter: number | null
  picking: boolean
  bottomInset: number
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  onPick: (at: Coordinates) => void
  onAnchorMove: (at: Coordinates) => void
  onLineFilter: (index: number) => void
}

function pillImage(fill: string, stroke: string) {
  const ratio = 2, width = 40, height = 24
  const canvas = document.createElement('canvas')
  canvas.width = width * ratio
  canvas.height = height * ratio
  const context = canvas.getContext('2d')!
  context.scale(ratio, ratio)
  context.beginPath()
  context.roundRect(1.5, 1.5, width - 3, height - 3, (height - 3) / 2)
  context.fillStyle = fill
  context.fill()
  context.lineWidth = 1.5
  context.strokeStyle = stroke
  context.stroke()
  return {
    image: context.getImageData(0, 0, canvas.width, canvas.height),
    options: { pixelRatio: ratio, stretchX: [[12 * ratio, 28 * ratio]] as [number, number][], stretchY: [[11 * ratio, 13 * ratio]] as [number, number][], content: [9 * ratio, 4 * ratio, 31 * ratio, 20 * ratio] as [number, number, number, number] },
  }
}

function tintBase(map: MapLibre) {
  const paint: [string, Parameters<MapLibre['setPaintProperty']>[1], string][] = [
    ['background', 'background-color', '#f3efe6'], ['landuse_residential', 'fill-color', '#ece7dc'], ['building', 'fill-color', '#e4ded1'],
    ['park', 'fill-color', '#e1e7d4'], ['landcover_wood', 'fill-color', '#dce4cf'], ['water', 'fill-color', '#c5d8e0'], ['waterway', 'line-color', '#c5d8e0'],
  ]
  for (const [layer, property, value] of paint) if (map.getLayer(layer)) map.setPaintProperty(layer, property, value)
}

const categoryFilter = (places: PlaceCategory[]): FilterSpecification => ['in', ['get', 'category'], ['literal', places]]
const placeColor = ['match', ['get', 'category'], ...placeCategories.flatMap((category) => [category.id, category.color]), '#888'] as unknown as ExpressionSpecification
const modeFilter = (modes: TransitMode[]): ExpressionSpecification => ['any', ...modes.map((mode): ExpressionSpecification => ['in', mode, ['get', 'modes']])]

function coverView(map: MapLibre, [west, south, east, north]: [number, number, number, number], bottomInset: number) {
  const { clientWidth: width, clientHeight: height } = map.getContainer()
  const mercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))
  const spanX = (east - west) / 360, spanY = (mercator(north) - mercator(south)) / (2 * Math.PI)
  const zoom = Math.max(Math.log2(Math.max(1, width) / (512 * spanX)), Math.log2(Math.max(1, height - bottomInset) / (512 * spanY)))
  return { center: [(west + east) / 2, (south + north) / 2] as Coordinates, zoom: Math.min(17, Math.max(0, zoom)) }
}

function install(map: MapLibre, theme: Theme) {
  const c = COLORS[theme]
  if (theme === 'light') tintBase(map)
  const layers = map.getStyle().layers
  // Area layers go under the first label above the buildings, so street names stay on top.
  const buildings = layers.findIndex((layer) => layer.id === 'building')
  const firstLabel = layers.find((layer, index) => index > buildings && layer.type === 'symbol')?.id
  for (const [id, fill] of [['pill', c.ink], ['pill-saved', c.saved], ['pill-focus', c.accent]] as const) {
    if (map.hasImage(id)) map.removeImage(id)
    const { image, options } = pillImage(fill, c.paper)
    map.addImage(id, image, options)
  }
  for (const id of ['reach', 'rings', 'transit', 'stops', 'route', 'places', 'daily', 'home-focus', 'park-areas']) map.addSource(id, { type: 'geojson', data: collection() })
  map.addSource('homes', { type: 'geojson', data: collection(), cluster: true, clusterRadius: 46, clusterMaxZoom: 14 })

  const parkPaint = { 'fill-color': c.park, 'fill-opacity': theme === 'light' ? .38 : .5 }
  map.addLayer({ id: 'parks', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover', filter: ['in', ['get', 'subclass'], ['literal', ['park', 'garden']]],
    paint: parkPaint }, firstLabel)
  map.addLayer({ id: 'park-areas', type: 'fill', source: 'park-areas', paint: parkPaint }, firstLabel)
  map.addLayer({ id: 'reach-veil', type: 'fill', source: 'reach', filter: ['==', ['get', 'part'], 'veil'], paint: { 'fill-color': c.veil, 'fill-opacity': theme === 'light' ? .62 : .55 } }, firstLabel)
  map.addLayer({ id: 'reach-line', type: 'line', source: 'reach', filter: ['==', ['get', 'part'], 'edge'], paint: { 'line-color': c.ink, 'line-width': 1.5, 'line-opacity': .55 } }, firstLabel)

  map.addLayer({ id: 'transit-focus', type: 'line', source: 'transit', filter: ['==', ['get', 'index'], -1], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 12, 'line-opacity': .28 } })
  map.addLayer({ id: 'transit', type: 'line', source: 'transit', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': ['get', 'color'],
    'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'mode'], 'bus', .7, 'tram', 1.3, 1.8], 16, ['match', ['get', 'mode'], 'bus', 2.4, 'tram', 3.6, 4.6]],
  } })
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.paper, 'line-width': 8 } })
  map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.accent, 'line-width': 4 } })
  map.addLayer({ id: 'stops-bus', type: 'circle', source: 'stops', minzoom: 15, filter: ['==', ['get', 'rail'], false],
    paint: { 'circle-radius': 3, 'circle-color': c.paper, 'circle-stroke-color': c.ink, 'circle-stroke-width': 1, 'circle-stroke-opacity': .6 } })
  map.addLayer({ id: 'stops-rail', type: 'circle', source: 'stops', minzoom: 11.5, filter: ['==', ['get', 'rail'], true],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 2.2, 16, 5.5], 'circle-color': c.paper, 'circle-stroke-color': c.ink, 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11.5, 1, 16, 2] } })
  map.addLayer({ id: 'stop-labels', type: 'symbol', source: 'stops', minzoom: 14, filter: ['==', ['get', 'rail'], true],
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, .9], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 8 },
    paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.6 } })

  map.addLayer({ id: 'places', type: 'circle', source: 'places', filter: categoryFilter([]),
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.8, 13, 3, 17, 5.5], 'circle-color': placeColor, 'circle-stroke-color': c.paper,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, .5, 14, 1] } })
  map.addLayer({ id: 'places-labels', type: 'symbol', source: 'places', minzoom: 16, filter: categoryFilter([]),
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-offset': [0, .9], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 8 },
    paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.4 } })
  map.addLayer({ id: 'places-near', type: 'circle', source: 'places', filter: categoryFilter([]),
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 4, 17, 7], 'circle-color': placeColor, 'circle-stroke-color': c.paper, 'circle-stroke-width': 1.5 } })
  map.addLayer({ id: 'places-near-labels', type: 'symbol', source: 'places', minzoom: 14.5, filter: categoryFilter([]),
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 8 },
    paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.4 } })

  const independent: ExpressionSpecification = ['==', ['get', 'independent'], true]
  map.addLayer({ id: 'daily-dots', type: 'circle', source: 'daily', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['case', independent, 2.5, 6.5], 13, ['case', independent, 4, 9], 16, ['case', independent, 6, 12]],
    'circle-color': ['get', 'color'],
    'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'gym'], c.ink, c.paper],
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 2.5] } })
  map.addLayer({ id: 'daily-initials', type: 'symbol', source: 'daily', filter: ['==', ['get', 'independent'], false],
    layout: { 'text-field': ['get', 'initials'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 7.5, 13, 9.5, 16, 11.5], 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': ['get', 'text'] } })
  map.addLayer({ id: 'daily-labels', type: 'symbol', source: 'daily', minzoom: 14.5,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.35], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 8 },
    paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.6 } })

  map.addLayer({ id: 'rings', type: 'line', source: 'rings', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': c.ink, 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': .75 } })
  map.addLayer({ id: 'ring-labels', type: 'symbol', source: 'rings', filter: ['==', ['geometry-type'], 'Point'],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-allow-overlap': true },
    paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 2 } })

  map.addLayer({ id: 'home-clusters', type: 'circle', source: 'homes', filter: ['has', 'point_count'],
    paint: { 'circle-color': c.ink, 'circle-radius': ['step', ['get', 'point_count'], 15, 10, 18, 50, 23], 'circle-stroke-color': c.paper, 'circle-stroke-width': 2 } })
  map.addLayer({ id: 'home-cluster-count', type: 'symbol', source: 'homes', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-allow-overlap': true }, paint: { 'text-color': c.paper } })
  const pin = (image: ExpressionSpecification | string, size: number) => ({
    'icon-image': image, 'icon-text-fit': 'both' as const, 'icon-text-fit-padding': [1, 5, 1, 5] as [number, number, number, number],
    'text-field': ['get', 'label'] as ExpressionSpecification, 'text-font': ['Noto Sans Bold'], 'text-size': size,
    'icon-allow-overlap': true, 'text-allow-overlap': true, 'symbol-sort-key': ['get', 'price'] as ExpressionSpecification,
  })
  map.addLayer({ id: 'home-pins', type: 'symbol', source: 'homes', filter: ['!', ['has', 'point_count']], layout: pin(['case', ['==', ['get', 'saved'], true], 'pill-saved', 'pill'], 12), paint: { 'text-color': c.paper } })
  map.addLayer({ id: 'home-focus', type: 'symbol', source: 'home-focus', layout: pin('pill-focus', 13), paint: { 'text-color': '#fff' } })
}

function element(tag: string, className?: string, text?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

function badge(line: { code: string, mode: string, color: string }) {
  const node = element('span', 'line-badge', line.code.length <= 5 ? line.code : line.mode)
  node.style.background = line.color
  node.style.color = textOn(line.color)
  return node
}

export default function MapView(props: MapViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibre | null>(null)
  const ready = useRef(false)
  const latest = useRef(props)
  latest.current = props
  const anchorMarker = useRef<Marker | null>(null)
  const popup = useRef<Popup | null>(null)
  const hovered = useRef<string | null>(null)
  const pendingLimits = useRef<{ zoom: number, bounds: Bounds } | null>(null)

  const source = (id: string) => mapRef.current?.getSource(id) as GeoJSONSource | undefined

  function syncHomes() {
    const { listings, savedIds } = latest.current
    source('homes')?.setData(collection(listings.map((listing) => ({ type: 'Feature', properties: { id: listing.id, price: listing.price,
      label: money(listing.price, listing.currency), saved: savedIds.has(listing.id) }, geometry: { type: 'Point', coordinates: listing.coordinates } }))))
  }

  function syncFocus() {
    const { listings, selected, hoverId } = latest.current
    const hover = listings.find((listing) => listing.id === hoverId)
    const shown = [selected, hover && hover.id !== selected?.id ? hover : null].filter((listing): listing is Listing => Boolean(listing))
    source('home-focus')?.setData(collection(shown.map((listing) => ({ type: 'Feature', properties: { id: listing.id, price: listing.price, label: money(listing.price, listing.currency) },
      geometry: { type: 'Point', coordinates: listing.coordinates } }))))
  }

  function syncTransit() {
    const { transit } = latest.current
    source('transit')?.setData(collection((transit?.features ?? []).map((feature, index) => ({ ...feature, properties: { ...feature.properties, index } }))))
    source('stops')?.setData(collection((transit?.stops ?? []).map((stop, index) => {
      const modes = [...new Set(stop.lines.map((line) => transit!.features[line]?.properties.mode).filter(Boolean))]
      return { type: 'Feature', properties: { index, name: stop.name, modes: modes.join(','), rail: modes.some((mode) => mode !== 'bus') }, geometry: { type: 'Point', coordinates: stop.coordinates } }
    })))
    source('places')?.setData(collection((transit?.pois ?? []).map((poi) => ({ type: 'Feature', properties: { category: poi.category, name: poi.name },
      geometry: { type: 'Point', coordinates: poi.coordinates } }))))
  }

  function syncLayers() {
    const map = mapRef.current!
    const { lineModes, places, lineFilter } = latest.current
    const modes = ['in', ['get', 'mode'], ['literal', lineModes]] as FilterSpecification
    map.setFilter('transit', modes)
    map.setFilter('transit-focus', ['==', ['get', 'index'], lineFilter ?? -1])
    map.setPaintProperty('transit', 'line-opacity', lineFilter == null ? ['match', ['get', 'mode'], 'bus', .5, .9] : ['case', ['==', ['get', 'index'], lineFilter], 1, .12])
    map.setFilter('stops-rail', ['all', ['==', ['get', 'rail'], true], modeFilter(lineModes)])
    map.setFilter('stops-bus', ['all', ['==', ['get', 'rail'], false], modeFilter(lineModes)])
    map.setFilter('stop-labels', ['all', ['==', ['get', 'rail'], true], modeFilter(lineModes)])
    const { parks } = latest.current
    map.setLayoutProperty('parks', 'visibility', places.includes('parks') && !parks ? 'visible' : 'none')
    map.setLayoutProperty('park-areas', 'visibility', places.includes('parks') && parks ? 'visible' : 'none')
    map.setFilter('places', categoryFilter(places))
    map.setFilter('places-labels', categoryFilter(places))
    syncNearby()
  }

  function syncNearby() {
    const map = mapRef.current!
    const { selected, places } = latest.current
    if (!selected) {
      source('rings')?.setData(collection())
      for (const id of ['places-near', 'places-near-labels']) map.setLayoutProperty(id, 'visibility', 'none')
      map.setPaintProperty('places', 'circle-opacity', .9)
      map.setPaintProperty('places', 'circle-stroke-opacity', .9)
      return
    }
    const rings = RING_MINUTES.map((minutes) => circle(selected.coordinates, RING_KM(minutes)))
    source('rings')?.setData(collection<Geometry>([
      ...rings.map((ring): Feature<Geometry> => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } })),
      ...rings.map((ring, index): Feature<Geometry> => ({ type: 'Feature', properties: { label: `${RING_MINUTES[index]} min walk` }, geometry: { type: 'Point', coordinates: ring[0] } })),
    ]))
    const area: Polygon = { type: 'Polygon', coordinates: [rings[rings.length - 1]] }
    const near = ['all', categoryFilter(places), ['within', area]] as FilterSpecification
    for (const id of ['places-near', 'places-near-labels']) { map.setFilter(id, near); map.setLayoutProperty(id, 'visibility', 'visible') }
    map.setPaintProperty('places', 'circle-opacity', .3)
    map.setPaintProperty('places', 'circle-stroke-opacity', .3)
  }

  function syncReach() {
    const { reach, minutes } = latest.current
    const area = reach?.features.find((feature) => feature.properties.minutes === minutes)
    if (!area) { source('reach')?.setData(collection()); return }
    const outlines = area.geometry.type === 'Polygon' ? [area.geometry.coordinates[0]] : area.geometry.coordinates.map((polygon) => polygon[0])
    const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]
    source('reach')?.setData(collection<Geometry>([
      { type: 'Feature', properties: { part: 'veil' }, geometry: { type: 'Polygon', coordinates: [world, ...outlines] } },
      { type: 'Feature', properties: { part: 'edge' }, geometry: { type: 'MultiLineString', coordinates: outlines } },
    ]))
  }

  function syncDaily() {
    source('daily')?.setData(collection(latest.current.dailyPlaces.map((place) => ({ type: 'Feature',
      properties: { kind: place.kind, chain: place.chain, name: place.name, color: place.color, text: textOn(place.color),
        initials: place.chain === OTHER_CHAIN ? '' : initials(place.chain), independent: place.chain === OTHER_CHAIN,
        label: place.chain === OTHER_CHAIN ? place.name : place.chain },
      geometry: { type: 'Point', coordinates: place.coordinates } }))))
  }

  function syncRoute() {
    const { route } = latest.current
    source('route')?.setData(collection(route ? [{ type: 'Feature', properties: {}, geometry: route.geometry }] : []))
  }

  function syncParks() {
    source('park-areas')?.setData(collection((latest.current.parks ?? []).map((rings): Feature<Polygon> => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } }))))
  }

  function syncAll() {
    if (!ready.current) return
    syncHomes(); syncFocus(); syncTransit(); syncParks(); syncLayers(); syncReach(); syncRoute(); syncDaily()
  }

  function showPopup(at: Coordinates, content: HTMLElement) {
    popup.current?.remove()
    popup.current = new Popup({ closeButton: true, maxWidth: '280px', className: 'map-popup', offset: 10 }).setLngLat(at).setDOMContent(content).addTo(mapRef.current!)
  }

  function onClick(event: MapMouseEvent) {
    const map = mapRef.current!
    const current = latest.current
    if (current.picking) { current.onPick([event.lngLat.lng, event.lngLat.lat]); return }
    const [hit] = map.queryRenderedFeatures(event.point, { layers: INTERACTIVE.filter((id) => map.getLayer(id)) })
    if (!hit) return
    const at: Coordinates = [event.lngLat.lng, event.lngLat.lat]
    const layer = hit.layer.id
    if (HOME_LAYERS.includes(layer)) current.onSelect(String(hit.properties.id))
    else if (layer === 'home-clusters') {
      const center = hit.geometry.type === 'Point' ? hit.geometry.coordinates as Coordinates : at
      source('homes')?.getClusterExpansionZoom(Number(hit.properties.cluster_id))
        .then((zoom) => { if (mapRef.current === map) map.easeTo({ center, zoom: zoom + .2 }) }).catch(() => {})
    } else if (layer === 'transit') {
      const index = Number(hit.properties.index)
      const line = current.transit?.features[index]?.properties
      if (!line) return
      const box = element('div', 'popup-body')
      const title = element('div', 'popup-title')
      title.append(badge(line), element('strong', '', line.name))
      box.append(title, element('small', '', line.operator))
      const actions = element('div', 'popup-actions')
      const filter = element('button', 'popup-button', current.lineFilter === index ? 'Showing homes near this line' : 'Homes near this line') as HTMLButtonElement
      filter.type = 'button'
      filter.addEventListener('click', () => { latest.current.onLineFilter(index); popup.current?.remove() })
      actions.append(filter)
      if (line.sourceUrl) {
        const link = element('a', 'popup-link', 'OpenStreetMap ↗') as HTMLAnchorElement
        link.href = line.sourceUrl
        link.target = '_blank'
        link.rel = 'noreferrer'
        actions.append(link)
      }
      box.append(actions)
      showPopup(at, box)
    } else if (layer === 'daily-dots') {
      const box = element('div', 'popup-body')
      const { name, chain, kind } = hit.properties
      box.append(element('strong', '', String(name || chain)), element('small', '', `${kind === 'gym' ? 'Gym' : 'Supermarket'}${name && name !== chain ? ` · ${chain}` : ''}`))
      showPopup(at, box)
    } else if (layer === 'stops-rail' || layer === 'stops-bus') {
      const stop = current.transit?.stops[Number(hit.properties.index)]
      if (!stop) return
      const box = element('div', 'popup-body')
      box.append(element('strong', '', stop.name || 'Stop'))
      const badges = element('div', 'popup-badges')
      const seen = new Set<string>()
      for (const index of stop.lines) {
        const line = current.transit?.features[index]?.properties
        if (!line || seen.has(`${line.mode}:${line.code}`)) continue
        seen.add(`${line.mode}:${line.code}`)
        badges.append(badge(line))
      }
      box.append(badges)
      showPopup(stop.coordinates, box)
    } else {
      const category = placeCategories.find((item) => item.id === hit.properties.category)
      const box = element('div', 'popup-body')
      box.append(element('strong', '', String(hit.properties.name || category?.label || 'Place')), element('small', '', category?.label ?? ''))
      showPopup(at, box)
    }
  }

  function onMove(event: MapMouseEvent) {
    const map = mapRef.current!
    if (latest.current.picking) { map.getCanvas().style.cursor = 'crosshair'; return }
    const hits = map.queryRenderedFeatures(event.point, { layers: INTERACTIVE.filter((id) => map.getLayer(id)) })
    map.getCanvas().style.cursor = hits.length ? 'pointer' : ''
    const home = hits.find((hit) => HOME_LAYERS.includes(hit.layer.id))
    const id = home ? String(home.properties.id) : null
    if (id !== hovered.current) { hovered.current = id; latest.current.onHover(id) }
  }

  useEffect(() => {
    if (!container.current) return
    const { theme, city } = latest.current
    const map = new MapLibre({ container: container.current, style: STYLES[theme], center: city.coordinates, zoom: 12, maxZoom: 18, attributionControl: false })
    mapRef.current = map
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right')
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    map.on('style.load', () => {
      install(map, latest.current.theme)
      ready.current = true
      syncAll()
    })
    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.on('mouseout', () => { if (hovered.current) { hovered.current = null; latest.current.onHover(null) } })
    map.on('moveend', () => {
      const limits = pendingLimits.current
      if (!limits || map.isMoving()) return
      map.setMinZoom(limits.zoom)
      map.setMaxBounds(limits.bounds)
      pendingLimits.current = null
    })
    const observer = new ResizeObserver(() => {
      map.resize()
      if (!pendingLimits.current) map.setMinZoom(coverView(map, cityView(latest.current.city.coordinates), latest.current.bottomInset).zoom)
    })
    observer.observe(container.current)
    return () => { observer.disconnect(); ready.current = false; anchorMarker.current = null; map.remove(); mapRef.current = null }
  }, [])

  const appliedTheme = useRef(props.theme)
  useEffect(() => {
    const map = mapRef.current
    if (!map || appliedTheme.current === props.theme) return
    appliedTheme.current = props.theme
    ready.current = false
    // Without a diff 'style.load' fires again, which reinstalls the data layers.
    map.setStyle(STYLES[props.theme], { diff: false })
  }, [props.theme])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const { center, zoom } = coverView(map, cityView(props.city.coordinates), props.bottomInset)
    const limits = { zoom, bounds: loadedArea(props.city.coordinates) }
    pendingLimits.current = null
    map.setMinZoom(null)
    map.setMaxBounds(null)
    map.flyTo({ center, zoom, padding: { top: 0, right: 0, left: 0, bottom: props.bottomInset }, duration: 1200 })
    pendingLimits.current = limits
    if (!map.isMoving()) {
      map.setMinZoom(limits.zoom)
      map.setMaxBounds(limits.bounds)
      pendingLimits.current = null
    }
  }, [props.city.id])

  useEffect(() => { if (ready.current) syncHomes() }, [props.listings, props.savedIds])
  useEffect(() => { if (ready.current) syncFocus() }, [props.selected, props.hoverId, props.listings])
  useEffect(() => { if (ready.current) { syncTransit(); syncLayers() } }, [props.transit])
  useEffect(() => { if (ready.current) { syncParks(); syncLayers() } }, [props.parks])
  useEffect(() => { if (ready.current) syncLayers() }, [props.lineModes, props.places, props.lineFilter, props.selected])
  useEffect(() => { if (ready.current) syncReach() }, [props.reach, props.minutes])
  useEffect(() => { if (ready.current) syncRoute() }, [props.route])
  useEffect(() => { if (ready.current) syncDaily() }, [props.dailyPlaces])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !props.selected) return
    popup.current?.remove()
    map.easeTo({ center: props.selected.coordinates, zoom: Math.max(map.getZoom(), 15), padding: { top: 0, right: 0, left: 0, bottom: props.bottomInset }, duration: 700 })
  }, [props.selected?.id])

  // Not on mount: easing there would stop the flight to the city.
  const appliedInset = useRef(props.bottomInset)
  useEffect(() => {
    if (appliedInset.current === props.bottomInset) return
    appliedInset.current = props.bottomInset
    mapRef.current?.easeTo({ padding: { top: 0, right: 0, left: 0, bottom: props.bottomInset }, duration: 300 })
  }, [props.bottomInset])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.getCanvas().style.cursor = props.picking ? 'crosshair' : ''
    if (props.picking) popup.current?.remove()
  }, [props.picking])

  useEffect(() => {
    const map = mapRef.current
    const { anchor } = props
    if (!map) return
    if (!anchor) { anchorMarker.current?.remove(); anchorMarker.current = null; return }
    if (!anchorMarker.current) {
      const node = element('div', 'anchor-pin')
      node.append(element('span', 'anchor-dot'), element('span', 'anchor-label'))
      node.title = 'Drag to adjust'
      const marker = new Marker({ element: node, draggable: true, anchor: 'center' }).setLngLat(anchor.coordinates).addTo(map)
      marker.on('dragend', () => { const at = marker.getLngLat(); latest.current.onAnchorMove([at.lng, at.lat]) })
      anchorMarker.current = marker
    }
    anchorMarker.current.setLngLat(anchor.coordinates)
    const label = anchorMarker.current.getElement().querySelector('.anchor-label')
    if (label) label.textContent = anchor.name
  }, [props.anchor])

  return <div ref={container} className="map" role="region" aria-label="Map of homes, transit lines and daily places" />
}
