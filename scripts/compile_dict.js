const fs = require('fs');
const path = require('path');

async function compileDictionary() {
  console.log("Fetching JLPT vocabulary database...");
  try {
    const response = await fetch('https://raw.githubusercontent.com/elzup/jlpt-word-list/master/out/all.csv');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const csvText = await response.text();
    const lines = csvText.split('\n');
    
    // CSV parser that handles quoted fields
    function parseCSVLine(line) {
      const result = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current.trim());
      return result;
    }

    const dict = {};
    
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const columns = parseCSVLine(line);
      if (columns.length < 4) continue;
      
      const expression = columns[0];
      const reading = columns[1];
      const meaning = columns[2].replace(/^"|"$/g, ''); // strip outer quotes
      const tags = columns[3];
      
      // Determine JLPT level (N1-N5). 
      // If a word has multiple levels, we pick the easiest/lowest level (e.g. N5 before N3)
      let level = null;
      if (tags.includes('n5')) level = 5;
      else if (tags.includes('n4')) level = 4;
      else if (tags.includes('n3')) level = 3;
      else if (tags.includes('n2')) level = 2;
      else if (tags.includes('n1')) level = 1;
      
      if (!level) continue;

      // Index expression (Kanji or Kana)
      if (!dict[expression] || dict[expression].level < level) {
        dict[expression] = {
          expression: expression,
          reading: reading,
          meaning: meaning,
          level: level
        };
      }

      // Also index by reading (Hiragana/Katakana) if distinct
      if (reading && (!dict[reading] || dict[reading].level < level)) {
        dict[reading] = {
          expression: expression,
          reading: reading,
          meaning: meaning,
          level: level
        };
      }
    }
    
    // Create dict directory if not exists
    const dictDir = path.join(__dirname, '..', 'dict');
    if (!fs.existsSync(dictDir)) {
      fs.mkdirSync(dictDir, { recursive: true });
    }
    
    fs.writeFileSync(
      path.join(dictDir, 'jlpt_dict.json'), 
      JSON.stringify(dict, null, 2)
    );
    
    console.log(`Successfully compiled local dictionary of ${Object.keys(dict).length} entries.`);
  } catch (error) {
    console.error("Compilation failed:", error);
  }
}

compileDictionary();
