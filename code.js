/**
 * PAGEGRID MCP-MASTER EXPORTER (v5.0 - Clean JSON Edition)
 * Trennt Struktur (JSON) von Binärdaten (Images) für LLM-Optimierung
 */

// Globaler Sammler für die aktuelle Export-Session
let imageCollector = [];

// --- HELPER FUNCTIONS ---

function safeVal(val, fallback) {
  return (val === figma.mixed || val === undefined || typeof val === 'symbol') ? fallback : val;
}

function getGrids(node) {
  if (!node.layoutGrids || node.layoutGrids === figma.mixed) return [];
  return node.layoutGrids.map(grid => ({
    pattern: grid.pattern,
    visible: grid.visible,
    alignment: grid.alignment,
    gutterSize: grid.gutterSize,
    offset: grid.offset,
    count: grid.count,
    sectionSize: grid.sectionSize
  }));
}

// --- VECTOR DETECTION HELPERS ---

const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "ELLIPSE", "POLYGON", "STAR", "LINE"]);

function isVectorType(node) {
  return VECTOR_TYPES.has(node.type);
}

function isVectorGroup(node) {
  if (node.type !== "GROUP" && node.type !== "FRAME") return false;
  if (!node.children || node.children.length === 0) return false;
  return node.children.every(child => isVectorType(child) || isVectorGroup(child));
}

// Extends VECTOR_TYPES to include RECTANGLE for composite shape detection.
const ALL_SHAPE_TYPES = new Set([...VECTOR_TYPES, "RECTANGLE"]);

// Returns true if a node and its entire subtree contain only shapes or
// groups of shapes — no TEXT, FRAME, or other non-shape nodes.
function isShapeSubtree(node) {
  if (ALL_SHAPE_TYPES.has(node.type)) return true;
  if (node.type === "GROUP" && node.children)
    return node.children.every(child => isShapeSubtree(child));
  return false;
}

// Counts RECTANGLE nodes anywhere in the subtree (recursively).
function countRectanglesInSubtree(node) {
  if (node.type === "RECTANGLE") return 1;
  if (node.type === "GROUP" && node.children)
    return node.children.reduce((sum, c) => sum + countRectanglesInSubtree(c), 0);
  return 0;
}

// Returns true for GROUP nodes whose entire subtree contains only shapes
// and has at least 2 RECTANGLEs anywhere within it.
// These represent composite shapes that should be captured as a single SVG.
function isCompositeShapeGroup(node) {
  if (node.type !== "GROUP") return false;
  if (!node.children || node.children.length === 0) return false;
  if (!node.children.every(c => isShapeSubtree(c))) return false;
  return countRectanglesInSubtree(node) >= 2;
}

// --- MAIN SERIALIZATION ---

async function serializeToMCP(node) {
  const obj = {
    id: node.id,
    name: node.name,
    type: node.type,
    absoluteBoundingBox: { 
      x: safeVal(node.x, 0), 
      y: safeVal(node.y, 0), 
      width: safeVal(node.width, 0), 
      height: safeVal(node.height, 0) 
    },
    fills: (node.fills !== figma.mixed && Array.isArray(node.fills)) ? node.fills.map(f => Object.assign({}, f)) : [],
    layoutGrids: getGrids(node),
    children: []
  };

  // --- Blend & visibility (only if non-default) ---
  const opacity = safeVal(node.opacity, 1);
  if (opacity !== 1) obj.opacity = opacity;
  const blendMode = safeVal(node.blendMode, 'NORMAL');
  if (blendMode && blendMode !== 'NORMAL' && blendMode !== 'PASS_THROUGH') obj.blendMode = blendMode;
  const rotation = safeVal(node.rotation, 0);
  if (rotation !== 0) obj.rotation = rotation;
  if (Array.isArray(node.effects) && node.effects.length > 0) obj.effects = node.effects.map(e => Object.assign({}, e));

  // --- Stroke / border (only if node has strokes) ---
  if (Array.isArray(node.strokes) && node.strokes.length > 0) {
    obj.strokes = node.strokes.map(s => Object.assign({}, s));
    obj.strokeWeight = safeVal(node.strokeWeight, 0);
    obj.strokeAlign = node.strokeAlign || undefined;
  }

  // --- Corner radius (only if non-zero) ---
  if ('cornerRadius' in node) {
    const cr = safeVal(node.cornerRadius, 0);
    if (cr !== 0) obj.cornerRadius = cr;
  }
  if ('topLeftRadius' in node) {
    const tl = node.topLeftRadius, tr = node.topRightRadius;
    const bl = node.bottomLeftRadius, br = node.bottomRightRadius;
    if (tl !== 0 || tr !== 0 || bl !== 0 || br !== 0) {
      obj.cornerRadii = { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br };
    }
  }

  // --- Auto-layout / flex (only if active) ---
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    obj.layoutMode = node.layoutMode;
    if ('paddingTop' in node && node.paddingTop !== 0)    obj.paddingTop    = node.paddingTop;
    if ('paddingRight' in node && node.paddingRight !== 0) obj.paddingRight  = node.paddingRight;
    if ('paddingBottom' in node && node.paddingBottom !== 0) obj.paddingBottom = node.paddingBottom;
    if ('paddingLeft' in node && node.paddingLeft !== 0)  obj.paddingLeft   = node.paddingLeft;
    if ('itemSpacing' in node && node.itemSpacing !== 0)  obj.itemSpacing   = node.itemSpacing;
    if (node.layoutWrap && node.layoutWrap !== 'NO_WRAP') obj.layoutWrap = node.layoutWrap;
    if (node.primaryAxisAlignItems) obj.primaryAxisAlignItems = node.primaryAxisAlignItems;
    if (node.counterAxisAlignItems) obj.counterAxisAlignItems = node.counterAxisAlignItems;
  }

  // 1. TEXT HANDLING (Rich-Text & LineHeight Fix)
  if (node.type === "TEXT") {
    obj.characters = node.characters;

    const textStyleId = node.textStyleId;
    if (typeof textStyleId === 'string') obj.textStyleId = textStyleId;
    
    const segments = node.getStyledTextSegments([
      "fontSize", "fontName", "lineHeight", "fills",
      "letterSpacing", "textDecoration", "textCase"
    ]);

    const firstSeg = segments.length > 0 ? segments[0] : null;

    obj.textSegments = segments.map(s => {
      let lh = { unit: "AUTO", value: s.fontSize * 1.2 };
      if (s.lineHeight && s.lineHeight.unit !== 'AUTO') {
        lh = { unit: s.lineHeight.unit, value: s.lineHeight.value };
      }
      return {
        characters: s.characters,
        fontSize: s.fontSize,
        fontFamily: s.fontName ? s.fontName.family : (firstSeg ? firstSeg.fontName.family : "sans-serif"),
        fontWeight: s.fontName ? s.fontName.style : (firstSeg ? firstSeg.fontName.style : "Regular"),
        lineHeight: lh,
        lineHeightPx: lh.unit === "PERCENT" ? (s.fontSize * lh.value / 100) : lh.value,
        letterSpacing: s.letterSpacing,
        textDecoration: s.textDecoration,
        textCase: s.textCase,
        fills: s.fills
      };
    });

    const fName = safeVal(node.fontName, firstSeg ? firstSeg.fontName : { family: "sans-serif", style: "Regular" });
    obj.style = {
      fontFamily: fName.family,
      fontSize: safeVal(node.fontSize, firstSeg ? firstSeg.fontSize : 16),
      lineHeight: node.lineHeight !== figma.mixed ? node.lineHeight : { unit: "AUTO" },
      textAlign: safeVal(node.textAlignHorizontal, "LEFT"),
      textAlignVertical: safeVal(node.textAlignVertical, "TOP"),
      paragraphSpacing: safeVal(node.paragraphSpacing, 0),
      paragraphIndent: safeVal(node.paragraphIndent, 0),
      opacity: safeVal(node.opacity, 1)
    };
  }

  // 2. SVG EXPORT
  const isSvgNode = isVectorType(node) || isVectorGroup(node) || node.name.toLowerCase().includes("(svg)");
  if (isSvgNode) {
    try {
      const svgString = await node.exportAsync({ format: 'SVG_STRING' });
      const safeName = node.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + "_" + node.id.replace(":", "-");
      imageCollector.push({ name: safeName, svgString: svgString, format: 'svg' });
      obj.mcp_svg_url = `assets/${safeName}.svg`;
      if (node.type !== "LINE") obj.type = "IMAGE";
      // Skip recursion — the whole node is captured in the SVG
      return obj;
    } catch (e) { console.error("SVG Error", e); }
  }

  // 2b. COMPOSITE SHAPE GROUP EXPORT
  // GROUP with >1 RECTANGLE where all children are shape types → export as single SVG
  if (isCompositeShapeGroup(node)) {
    try {
      const svgString = await node.exportAsync({ format: 'SVG_STRING' });
      const safeName = node.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + "_" + node.id.replace(":", "-");
      imageCollector.push({ name: safeName, svgString: svgString, format: 'svg' });
      obj.mcp_svg_url = `assets/${safeName}.svg`;
      obj.type = "IMAGE";
      // Skip recursion — the whole group is captured in the SVG
      return obj;
    } catch (e) { console.error("SVG Error (composite shape group)", e); }
  }
  
  // 3. IMAGE EXPORT (Sammler-Logik statt Base64)
  const hasImageFill = node.fills !== figma.mixed && Array.isArray(node.fills) && node.fills.some(f => f.type === 'IMAGE');
  
  if (node.name.toLowerCase().includes("pg_image") || hasImageFill) {
    try {
      // Detect original image format via magic bytes
      let exportFormat = 'PNG';
      let ext = 'png';
      const imageFill = Array.isArray(node.fills) && node.fills.find(f => f.type === 'IMAGE');
      if (imageFill && imageFill.imageHash) {
        const rawBytes = await figma.getImageByHash(imageFill.imageHash).getBytesAsync();
        if (rawBytes[0] === 0xFF && rawBytes[1] === 0xD8) {
          exportFormat = 'JPG';
          ext = 'jpg';
        }
        // PNG magic: 0x89 0x50 — already the default
      }

      const bytes = await node.exportAsync({ format: exportFormat, constraint: { type: 'SCALE', value: 2.5 } });
      
      // Dateiname generieren: kleingeschrieben, ohne Sonderzeichen + ID für Eindeutigkeit
      const safeName = node.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + "_" + node.id.replace(":", "-");
      
      // In globalen Sammler schieben
      imageCollector.push({
        name: safeName,
        bytes: bytes,
        format: ext
      });

      // Im JSON nur der Pfad für das LLM
      obj.mcp_image_url = `assets/${safeName}.${ext}`;
      
    } catch (e) { console.error("Image Export failed for " + node.name, e); }
  }

  // 4. REKURSION
  if ("children" in node) {
    obj.children = await Promise.all(node.children.map(child => serializeToMCP(child)));
  }
  
  return obj;
}

// --- PLUGIN RUNNER ---

async function doExport() {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'waiting' });
    return;
  }

  imageCollector = []; // Reset für neuen Durchlauf

  try {
    const documentData = await serializeToMCP(selection[0]);

    documentData.textStyles = figma.getLocalTextStyles().map(style => ({
      id: style.id,
      name: style.name,
      fontSize: style.fontSize,
      fontFamily: style.fontName ? style.fontName.family : undefined,
      fontWeight: style.fontName ? style.fontName.style : undefined,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      paragraphSpacing: style.paragraphSpacing,
      paragraphIndent: style.paragraphIndent,
      textCase: style.textCase,
      textDecoration: style.textDecoration,
      fills: style.fills
    }));

    figma.ui.postMessage({ 
      type: 'data-ready', 
      payload: documentData, 
      images: imageCollector,
      fileName: selection[0].name.replace(/[^a-z0-9]/gi, '_').toLowerCase() 
    });

  } catch (err) {
    figma.notify("💥 Error: " + err.message);
    console.error(err);
  }
}

function runExport() {
  figma.showUI(__html__, { width: 320, height: 190, title: "Export to PageGrid" });
  doExport();
  figma.on('selectionchange', doExport);
}

runExport();