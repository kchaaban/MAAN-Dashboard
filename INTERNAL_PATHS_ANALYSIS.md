# Internal Paths & Animation Analysis

## 📋 CSV Structure Comparison

### simulation_data_final.csv vs Current CSV
- **Same columns**: Both have 43 columns
- **Key field**: `internal_path` (GeoJSON LineString format)

### Current CSV Structure (43 columns):
1. plan_id
2. camp_label
3. allocated_haj
4. number_of_buses
5. number_of_haj
6. number_of_late_haj
7. number_of_early_haj
8. license_number
9. residence_haj
10. tarwia
11. direct_taseed
12. get_type_parking
13. get_parking_name
14. get_parking_geom
15. set_type_parking
16. set_parking_name
17. set_parking_geom
18. entrance_asm_code
19. entrance_name
20. entrance_point_geom
21. entrance_polygon
22. start_point_type
23. start_point_name
24. start_point_district
25. start_point_geom
26. start_geom
27. end_point_type
28. end_point_name
29. end_point_geom
30. end_geom
31. path_geom (external path - WKT LineString)
32. path_name
33. **internal_path** ← KEY FIELD (GeoJSON LineString)
34. owner_company_name
35. owner_office_number
36. period
37. timing_start_at
38. timing_start_at_hijri
39. timing_end_at
40. timing_end_at_hijri
41. plan_type_name
42. plan_type_code
43. transport_type_name

---

## 🔍 Why Internal Paths Are Not Showing

### Issue 1: Format Handling ✅ (WORKS)
The code CAN parse GeoJSON:
```javascript
// app.js line 1498-1500
if (str.startsWith('{')) {
    try { return JSON.parse(str); } catch (e) { return null; }
}
```
The `internal_path` is GeoJSON format: `{"type":"LineString","coordinates":[[lng,lat],...]}` ✓

### Issue 2: Path Rendering ✅ (WORKS)
The code renders internal paths:
```javascript
// app.js line 1550-1552
if (row['internal_path']) {
    const internalGeojson = parseGeom(row['internal_path']);
    if (internalGeojson && internalGeojson.coordinates) 
        geojsonsToRender.push({ geojson: internalGeojson, type: 'internal' });
}
```

### Issue 3: Map Rendering ✅ (WORKS)
LineString geometries ARE rendered:
```javascript
// app.js line 3133-3153
} else if (geojson.type === 'LineString' || geojson.type === 'MultiLineString') {
    // ... renders with color '#10b981' (green)
    const polyline = L.polyline(latlngs, {
        color: color,      // GREEN for internal paths
        weight: 4,
        opacity: 0.95
    }).addTo(routeLayerGroup);
```

### ❌ Possible Reasons They're Not Visible:

1. **Filtering by plan type**: Check if `internal_path` only exists for certain plan types
2. **Zoom level**: Are you zoomed in enough? Check `MAP_LABEL_MIN_ZOOM = 15`
3. **Route layer not visible**: Check if `routeLayerGroup` is hidden
4. **Empty internal_path**: Some rows might have empty/null internal_path values
5. **Coordinate order**: GeoJSON uses [lng, lat], code converts to [lat, lng] correctly at line 3136

---

## 🎬 Animation Direction Issue

### Root Cause: Path Orientation Logic
The animation direction depends on the order of coordinates in the path. The problem is in:

```javascript
// app.js line 1672-1700: orientLatLngsForRoute()
function orientLatLngsForRoute(latlngs, row, item) {
    const thresholdMeters = item?.type === 'internal' ? 1 : 6;  // ← Line 1679
    
    // Reverses path if endAnchor is closer to START than startAnchor
    // For internal paths, threshold is very tight (1 meter)
    // This means even slight distance mismatches trigger a reverse
    
    const reverseScore = getLatLngDistance(last, startAnchor) + 
                         getLatLngDistance(first, endAnchor);
    return reverseScore + thresholdMeters < forwardScore ? 
           [...latlngs].reverse() : latlngs;
}
```

### ❌ Animation Problems:

1. **Coordinate order mismatch**: 
   - CSV `internal_path` coordinates might start at location A and end at location B
   - But `start_point_geom` and `end_point_geom` might not match those endpoints
   - The reverse logic tries to fix this but may overcorrect

2. **Threshold too tight**:
   - For internal paths: `1 meter` threshold (line 1679)
   - For external paths: `6 meter` threshold
   - This makes internal paths reverse-prone

3. **Animation arrows direction**:
   ```javascript
   // app.js line 3158
   addDirectionalArrows(latlngs, color);  // Uses current latlngs order
   ```
   If `latlngs` was reversed by `orientLatLngsForRoute()`, arrows point backward

---

## ✅ Solutions Needed

### 1. **Verify internal_path data**
```bash
# Check if internal_path has coordinates
grep "internal_path" simulation_data_final.csv | head -5 | cut -d',' -f33
```

### 2. **Debug coordinate endpoints**
For each plan, verify:
- `internal_path` start point matches `start_point_geom` ✓
- `internal_path` end point matches `end_point_geom` ✓

### 3. **Increase threshold for better matching**
Change line 1679 from:
```javascript
const thresholdMeters = item?.type === 'internal' ? 1 : 6;
```
To:
```javascript
const thresholdMeters = item?.type === 'internal' ? 10 : 6;  // More lenient
```

### 4. **Add explicit direction validation**
Ensure the coordinates in the CSV follow:
- Start → End (logical progression)
- Not reversed or random order

---

## 📊 Data Quality Checklist

- [ ] `internal_path` coordinates start at `start_point_geom` location
- [ ] `internal_path` coordinates end at `end_point_geom` location
- [ ] No coordinate reversals or out-of-order sequences
- [ ] All `internal_path` values are valid GeoJSON LineStrings
- [ ] No null or empty `internal_path` values where expected
