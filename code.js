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
  if (node.children.some(c => hasPgImageInSubtree(c))) return false;
  return node.children.every(child => isVectorType(child) || isVectorGroup(child));
}

// Extends VECTOR_TYPES to include RECTANGLE for composite shape detection.
const ALL_SHAPE_TYPES = new Set([...VECTOR_TYPES, "RECTANGLE"]);

// Returns true if any node in the subtree is named "pg_image" or starts with "pg_image".
// Used to exclude groups that act as image placeholders from SVG composite detection.
function hasPgImageInSubtree(node) {
  if (node.name && node.name.startsWith("pg_image")) return true;
  if (node.children) return node.children.some(c => hasPgImageInSubtree(c));
  return false;
}

// Returns true for GROUP nodes whose direct children are all shapes (or qualifying nested
// shape groups) and that don't reduce to a single lone rectangle.
// Any TEXT, FRAME, IMAGE, or other non-shape child makes this return false.
function isCompositeShapeGroup(node) {
  if (node.type !== "GROUP") return false;
  if (!node.children || node.children.length === 0) return false;
  if (node.children.some(c => hasPgImageInSubtree(c))) return false;
  if (!node.children.every(c => ALL_SHAPE_TYPES.has(c.type) || isCompositeShapeGroup(c))) return false;
  // Must have at least one direct shape child — groups of groups should recurse, not collapse
  if (!node.children.some(c => ALL_SHAPE_TYPES.has(c.type))) return false;
  // A single lone rectangle doesn't need to be captured as an SVG
  const rectangleCount = node.children.filter(c => c.type === "RECTANGLE").length;
  if (rectangleCount === 1 && node.children.length === 1) return false;
  return true;
}

// --- MAIN SERIALIZATION ---

async function serializeToMCP(node, forceSvg = false) {
  if (node.visible === false) return null;

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
    if (node.primaryAxisSizingMode) obj.primaryAxisSizingMode = node.primaryAxisSizingMode;
    if (node.counterAxisSizingMode) obj.counterAxisSizingMode = node.counterAxisSizingMode;
    if ('counterAxisSpacing' in node && node.counterAxisSpacing !== 0) obj.counterAxisSpacing = node.counterAxisSpacing;
  }

  if ('layoutPositioning' in node && node.layoutPositioning !== 'AUTO') obj.layoutPositioning = node.layoutPositioning;
  if ('layoutAlign' in node && node.layoutAlign !== 'INHERIT') obj.layoutAlign = node.layoutAlign;
  if ('layoutGrow' in node && node.layoutGrow !== 0) obj.layoutGrow = node.layoutGrow;

  // 1. TEXT HANDLING (Rich-Text & LineHeight Fix)
  if (node.type === "TEXT") {
    obj.characters = node.characters;

    const textStyleId = node.textStyleId;
    if (typeof textStyleId === 'string') obj.textStyleId = textStyleId;
    
    const segments = node.getStyledTextSegments([
      "fontSize", "fontName", "fontWeight", "fontStyle", "lineHeight", "fills",
      "letterSpacing", "textDecoration", "textDecorationStyle", "textCase",
      "listOptions", "indentation", "paragraphSpacing", "paragraphIndent",
      "listSpacing", "hyperlink"
    ]);

    const firstSeg = segments.length > 0 ? segments[0] : null;

    obj.textSegments = segments.map(s => {
      let lh = { unit: "AUTO", value: s.fontSize * 1.2 };
      if (s.lineHeight && s.lineHeight.unit !== 'AUTO') {
        lh = { unit: s.lineHeight.unit, value: s.lineHeight.value };
      }
      const segObj = {
        characters: s.characters,
        fontSize: s.fontSize,
        fontFamily: s.fontName ? s.fontName.family : (firstSeg ? firstSeg.fontName.family : "sans-serif"),
        fontWeight: s.fontName ? s.fontName.style : (firstSeg ? firstSeg.fontName.style : "Regular"),
        lineHeight: lh,
        lineHeightPx: lh.unit === "PERCENT" ? (s.fontSize * lh.value / 100) : lh.value,
        letterSpacing: s.letterSpacing,
        fills: s.fills
      };
      if (s.textDecoration && s.textDecoration !== 'NONE') segObj.textDecoration = s.textDecoration;
      if (s.textCase && s.textCase !== 'ORIGINAL') segObj.textCase = s.textCase;
      if (s.fontStyle && s.fontStyle !== 'REGULAR') segObj.fontStyle = s.fontStyle;
      if (s.textDecorationStyle != null) segObj.textDecorationStyle = s.textDecorationStyle;
      if (s.listOptions && s.listOptions.type !== 'NONE') segObj.listOptions = s.listOptions;
      if (s.indentation > 0) segObj.indentation = s.indentation;
      if (s.paragraphSpacing > 0) segObj.paragraphSpacing = s.paragraphSpacing;
      if (s.paragraphIndent > 0) segObj.paragraphIndent = s.paragraphIndent;
      if (s.listSpacing > 0) segObj.listSpacing = s.listSpacing;
      if (s.hyperlink && s.hyperlink !== figma.mixed) segObj.hyperlink = s.hyperlink;
      return segObj;
    });

    const fName = safeVal(node.fontName, firstSeg ? firstSeg.fontName : { family: "sans-serif", style: "Regular" });
    obj.style = {
      fontFamily: fName.family,
      fontSize: safeVal(node.fontSize, firstSeg ? firstSeg.fontSize : 16),
      lineHeight: node.lineHeight !== figma.mixed ? node.lineHeight : { unit: "AUTO" },
      textAlign: safeVal(node.textAlignHorizontal, "LEFT"),
      textAlignVertical: safeVal(node.textAlignVertical, "TOP"),
      opacity: safeVal(node.opacity, 1)
    };
    if (node.paragraphSpacing !== figma.mixed && node.paragraphSpacing > 0)
      obj.style.paragraphSpacing = node.paragraphSpacing;
    if (node.paragraphIndent !== figma.mixed && node.paragraphIndent > 0)
      obj.style.paragraphIndent = node.paragraphIndent;
    if (node.listSpacing !== figma.mixed && node.listSpacing > 0)
      obj.style.listSpacing = node.listSpacing;
    if (safeVal(node.hangingPunctuation, false) === true)
      obj.style.hangingPunctuation = true;
    if (safeVal(node.hangingList, false) === true)
      obj.style.hangingList = true;
    const lt = node.leadingTrim !== figma.mixed ? node.leadingTrim : null;
    if (lt && (typeof lt === 'string' ? lt !== 'NONE' : lt.type !== 'NONE'))
      obj.style.leadingTrim = lt;
    if (node.hyperlink && node.hyperlink !== figma.mixed) obj.style.hyperlink = node.hyperlink;
  }

  // 2. SVG EXPORT
  const isSvgNode = isVectorType(node) || isVectorGroup(node)
    || node.name.toLowerCase().includes("(svg)")
    || (forceSvg && node.type === "RECTANGLE");
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

      const exportConstraint = node.width > 1200
        ? { type: 'WIDTH', value: 3000 }
        : { type: 'SCALE', value: 2.5 };
      const bytes = await node.exportAsync({ format: exportFormat, constraint: exportConstraint });
      
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
    // Filter out hidden children
    const visibleChildren = node.children.filter(c => c.visible !== false);

    // Mixed group: 2+ direct RECTANGLEs alongside non-shape children (e.g. TEXT) →
    // each RECTANGLE gets exported as its own SVG instead of as a layout node.
    const directRects = visibleChildren.filter(c => c.type === "RECTANGLE");
    const hasNonShapes = visibleChildren.some(c => !ALL_SHAPE_TYPES.has(c.type) && c.type !== "GROUP");
    const forceSvgForRects = directRects.length >= 2 && hasNonShapes;

    obj.children = await Promise.all(
      visibleChildren.map(child => {
        const shouldForceSvg = forceSvgForRects
          && child.type === "RECTANGLE"
          && !coversParent(child, node);
        return serializeToMCP(child, shouldForceSvg);
      })
    );
  }
  
  return obj;
}

// --- FULL-COVER DETECTION ---

// Returns true if a child rectangle matches the width and height of its parent group,
// indicating it's a background/styling element that should stay as a layout node.
function coversParent(child, parent) {
  return child.width === parent.width && child.height === parent.height;
}

// --- FLATTEN SINGLE-CHILD GROUP CHAINS ---

// Collapses GROUP > GROUP > ... > content chains where each intermediate
// GROUP has exactly one child (also a GROUP). The innermost GROUP with
// real content is kept; wrapper groups are discarded.
function flattenSingleChildGroups(node) {
  // Bottom-up: process children first so nested chains fully resolve
  if (Array.isArray(node.children) && node.children.length > 0)
    node.children = node.children.map(flattenSingleChildGroups);

  // Collapse: while this GROUP's only child is also a GROUP, skip the wrapper
  while (
    node.type === "GROUP" &&
    Array.isArray(node.children) &&
    node.children.length === 1 &&
    node.children[0].type === "GROUP"
  ) {
    node.children = node.children[0].children;
  }
  return node;
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
    const documentData = flattenSingleChildGroups(await serializeToMCP(selection[0]));

    documentData.textStyles = (await figma.getLocalTextStylesAsync()).map(style => ({
      id: style.id,
      name: style.name,
      fontSize: style.fontSize,
      fontFamily: style.fontName ? style.fontName.family : undefined,
      fontWeight: style.fontName ? style.fontName.style : undefined,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      paragraphSpacing: style.paragraphSpacing,
      paragraphIndent: style.paragraphIndent,
      listSpacing: style.listSpacing,
      hangingPunctuation: style.hangingPunctuation,
      hangingList: style.hangingList,
      leadingTrim: style.leadingTrim,
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