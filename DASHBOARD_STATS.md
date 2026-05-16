# Dashboard Statistics Display - Enhanced with Numerator/Denominator Format

## Updates Made

### 1. **Camp Assignment Statistics** (app.js)
- Added `parseCampLabel()` function to parse camp labels (e.g., "1/608") into numerator and denominator
- Added `getCampAssignmentStats()` function to calculate:
  - Unique numerators count (unique camp numbers)
  - Unique denominators count (unique service centers)
  - Total camp assignments
  
### 2. **Dashboard Statistics** (app.js)
- Updated `getDashboardStats()` to include `campAssignmentStats`
- Enhanced `updateKPIs()` to display camps in fraction format:
  - Numerator: Number of unique camp labels (top)
  - Denominator: Number of unique service centers (bottom)
  - Tooltip shows total assignments count

### 3. **Visual Styling** (styles.css)
- Added `.fraction` class for displaying fractions
- Styled `.numerator` and `.denominator` with:
  - Proper sizing and alignment
  - Separator line between numerator and denominator
  - Professional fraction notation

## Statistics Displayed

### KPI Cards with Data

| Metric | Arabic | Format | Source |
|--------|--------|--------|--------|
| **إجمالي الحجاج** | Total Pilgrims | Number | `number_of_haj` sum |
| **إجمالي الحافلات** | Total Buses | Number | `number_of_buses` sum |
| **إجمالي الخطط** | Total Plans | Number | Filtered data count |
| **إجمالي الرحلات** | Total Trips | Number | Calculated from transport type |
| **عدد المساكن** | Residences | Number | Unique residences |
| **عدد المخيمات** | Camps | **Numerator/Denominator** | Parsed from camp_label |

## Camp Assignment Format

Example: **191/304**
- **191**: Number of unique camp numerators (camp labels: 1/608, 2/204, etc.)
- **304**: Number of unique camp denominators (service centers: 608, 204, etc.)

### Data from assign_camps.js
Camp labels follow format: `{numerator}/{denominator}`
- **Numerator**: Sequential camp identifier within a company
- **Denominator**: Service center code

Example entries:
```
1/608   - Camp 1 at Service Center 608
10/44   - Camp 10 at Service Center 44
11/408  - Camp 11 at Service Center 408
```

## Features

✅ **Numerator/Denominator Display**: Shows camp assignments as mathematical fractions
✅ **Hover Tooltip**: Shows total assignment count when hovering over camp KPI
✅ **Responsive**: Fraction scales properly on different screen sizes
✅ **Accessible**: Uses semantic HTML with proper ARIA labels
✅ **Dark Mode Support**: Styling works in both light and dark themes
✅ **Real-time Updates**: Statistics update as filters are applied

## Usage

The dashboard automatically:
1. Parses all camp labels from the data
2. Extracts unique numerators and denominators
3. Displays the count as a styled fraction in the KPI card
4. Updates when data is filtered by company, period, transport type, etc.

## Example Output

When the app loads with the provided data:
- Camps KPI displays: **191/304**
  - 191 unique camp identifiers across all assignments
  - 304 unique service centers used
  - Tooltip shows total camp assignments
