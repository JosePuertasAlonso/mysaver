#!/usr/bin/env python3
"""Genera informe PDF para la declaracion de la renta de un año dado."""

import sys
import json
from datetime import datetime

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, PageBreak
)
from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT

# ── Args ─────────────────────────────────────────────────────────────────────
if len(sys.argv) < 3:
    print("Uso: python generar_renta.py <data_json_path> <out_path>", file=sys.stderr)
    sys.exit(1)

DATA_PATH = sys.argv[1]
OUTPDF    = sys.argv[2]

# ── Data ─────────────────────────────────────────────────────────────────────
with open(DATA_PATH, encoding='utf-8') as f:
    data = json.load(f)

año        = data['año']
ventas_acc = data['ventas_acc']
dividendos = data['dividendos']
ventas_etf = data['ventas_etf']

# ── Styles ───────────────────────────────────────────────────────────────────
AZUL      = colors.HexColor('#1a3a5c')
AZUL_CLARO= colors.HexColor('#e8f0f8')
GRIS      = colors.HexColor('#f5f5f5')
VERDE     = colors.HexColor('#1a6e3e')
ROJO      = colors.HexColor('#8b1a1a')
NEGRO     = colors.HexColor('#1a1a1a')

styles = getSampleStyleSheet()

S_TITLE   = ParagraphStyle('title',   fontName='Helvetica-Bold',   fontSize=20, textColor=AZUL,  alignment=TA_CENTER, spaceAfter=4)
S_SUB     = ParagraphStyle('sub',     fontName='Helvetica',        fontSize=11, textColor=colors.HexColor('#444'), alignment=TA_CENTER, spaceAfter=2)
S_H1      = ParagraphStyle('h1',      fontName='Helvetica-Bold',   fontSize=13, textColor=AZUL,  spaceBefore=14, spaceAfter=6)
S_H2      = ParagraphStyle('h2',      fontName='Helvetica-Bold',   fontSize=10, textColor=NEGRO, spaceBefore=8,  spaceAfter=4)
S_BODY    = ParagraphStyle('body',    fontName='Helvetica',        fontSize=9,  textColor=NEGRO, spaceAfter=4)
S_NOTA    = ParagraphStyle('nota',    fontName='Helvetica-Oblique',fontSize=8,  textColor=colors.HexColor('#666'), spaceAfter=3)
S_RESUMEN = ParagraphStyle('resumen', fontName='Helvetica-Bold',   fontSize=10, textColor=AZUL,  spaceBefore=6)

def euro(v):
    if v is None: return '—'
    sign = '+' if v > 0 else ''
    return f"{sign}{v:,.2f} €".replace(',', 'X').replace('.', ',').replace('X', '.')

def eur(v):
    if v is None: return '—'
    return f"{v:,.2f} €".replace(',', 'X').replace('.', ',').replace('X', '.')

def fdate(s):
    if not s: return '—'
    try: return datetime.strptime(s[:10], '%Y-%m-%d').strftime('%d/%m/%Y')
    except: return s

TABLE_HDR = [
    ('BACKGROUND', (0,0), (-1,0), AZUL),
    ('TEXTCOLOR',  (0,0), (-1,0), colors.white),
    ('FONTNAME',   (0,0), (-1,0), 'Helvetica-Bold'),
    ('FONTSIZE',   (0,0), (-1,-1), 8),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, GRIS]),
    ('GRID',       (0,0), (-1,-1), 0.3, colors.HexColor('#cccccc')),
    ('LEFTPADDING',  (0,0), (-1,-1), 5),
    ('RIGHTPADDING', (0,0), (-1,-1), 5),
    ('TOPPADDING',   (0,0), (-1,-1), 4),
    ('BOTTOMPADDING',(0,0), (-1,-1), 4),
    ('VALIGN',     (0,0), (-1,-1), 'MIDDLE'),
]

def color_ganancia(data, col, start_row=1):
    """Colorea celdas de ganancia/pérdida."""
    styles_extra = []
    for i, row in enumerate(data[start_row:], start=start_row):
        try:
            val_str = row[col].replace('.', '').replace(',', '.').replace(' €', '').replace('+', '').strip()
            val = float(val_str)
            c = VERDE if val >= 0 else ROJO
            styles_extra.append(('TEXTCOLOR', (col, i), (col, i), c))
            styles_extra.append(('FONTNAME',  (col, i), (col, i), 'Helvetica-Bold'))
        except: pass
    return styles_extra

# ── Build PDF ────────────────────────────────────────────────────────────────
doc = SimpleDocTemplate(
    OUTPDF, pagesize=A4,
    leftMargin=1.8*cm, rightMargin=1.8*cm,
    topMargin=1.8*cm, bottomMargin=1.8*cm,
    title=f"Informe Renta {año}",
    author="Mi Patrimonio"
)
story = []

# ── Portada / Cabecera ───────────────────────────────────────────────────────
story.append(Spacer(1, 0.5*cm))
story.append(Paragraph(f"Informe para la Declaración de la Renta", S_TITLE))
story.append(Paragraph(f"Ejercicio fiscal {año}", S_SUB))
story.append(Paragraph(f"Generado el {datetime.now().strftime('%d/%m/%Y a las %H:%M')}", S_NOTA))
story.append(HRFlowable(width="100%", thickness=2, color=AZUL, spaceAfter=12))

# ── SECCIÓN 1: Dividendos ────────────────────────────────────────────────────
story.append(Paragraph("1. Rendimientos del Capital Mobiliario — Dividendos", S_H1))
story.append(Paragraph(
    "Los dividendos tributan en la base del ahorro del IRPF. "
    "Debes declarar el importe íntegro (bruto) recibido y descontar la retención practicada.",
    S_BODY))

if dividendos:
    total_bruto   = sum(r['bruto']    or 0 for r in dividendos)
    total_neto    = sum(r['neto']     or 0 for r in dividendos)
    total_ret     = sum(r['retencion']or 0 for r in dividendos)

    hdr = ['Acción', 'Fecha cobro', 'Importe bruto', 'Retención', 'Importe neto']
    rows = [hdr]
    for r in dividendos:
        rows.append([
            r['accion'],
            fdate(r['fecha']),
            eur(r['bruto']),
            eur(r['retencion']),
            eur(r['neto']),
        ])
    rows.append([
        Paragraph('<b>TOTAL</b>', styles['Normal']),
        '',
        Paragraph(f'<b>{eur(total_bruto)}</b>', styles['Normal']),
        Paragraph(f'<b>{eur(total_ret)}</b>',   styles['Normal']),
        Paragraph(f'<b>{eur(total_neto)}</b>',  styles['Normal']),
    ])

    col_w = [5.5*cm, 2.5*cm, 3*cm, 2.5*cm, 3*cm]
    t = Table(rows, colWidths=col_w, repeatRows=1)
    ts = TableStyle(TABLE_HDR + [
        ('BACKGROUND', (0,-1), (-1,-1), AZUL_CLARO),
        ('FONTNAME',   (0,-1), (-1,-1), 'Helvetica-Bold'),
        ('ALIGN',      (2,0),  (-1,-1), 'RIGHT'),
    ])
    t.setStyle(ts)
    story.append(t)
    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph(
        f"<b>Resumen:</b> Ingresos brutos <b>{eur(total_bruto)}</b> · "
        f"Retenciones ya pagadas <b>{eur(total_ret)}</b> · "
        f"Neto percibido <b>{eur(total_neto)}</b>",
        S_RESUMEN))
    story.append(Paragraph(
        "Nota: Indica el importe bruto en la casilla de dividendos y la retención en la casilla de retenciones a cuenta.",
        S_NOTA))
else:
    story.append(Paragraph(f"No se registraron dividendos en {año}.", S_BODY))

story.append(Spacer(1, 0.5*cm))

# ── SECCIÓN 2: Ganancias/Pérdidas en Acciones ────────────────────────────────
story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#cccccc'), spaceAfter=8))
story.append(Paragraph("2. Ganancias y Pérdidas Patrimoniales — Acciones", S_H1))
story.append(Paragraph(
    "Las transmisiones de acciones generan ganancias o pérdidas patrimoniales que tributan "
    "en la base del ahorro. El valor de compra incluye las comisiones de adquisición y conversión "
    "de divisa; el valor de venta se minora con las comisiones de venta.",
    S_BODY))

if ventas_acc:
    total_compra  = sum(r['total_compra'] or 0 for r in ventas_acc)
    total_venta   = sum(r['total_venta']  or 0 for r in ventas_acc)
    total_benef   = sum(r['beneficio']    or 0 for r in ventas_acc)

    hdr = ['Acción', 'F. Compra', 'F. Venta', 'Títulos', 'Coste compra', 'Ingreso venta', 'Ganancia/Pérdida']
    rows = [hdr]
    for r in ventas_acc:
        rows.append([
            r['accion'],
            fdate(r['fecha_compra']),
            fdate(r['fecha_venta']),
            str(int(r['titulos'])) if r['titulos'] and r['titulos'] == int(r['titulos']) else str(r['titulos']),
            eur(r['total_compra']),
            eur(r['total_venta']),
            euro(r['beneficio']),
        ])
    rows.append([
        Paragraph('<b>TOTAL</b>', styles['Normal']),
        '', '', '',
        Paragraph(f'<b>{eur(total_compra)}</b>',  styles['Normal']),
        Paragraph(f'<b>{eur(total_venta)}</b>',   styles['Normal']),
        Paragraph(f'<b>{euro(total_benef)}</b>',  styles['Normal']),
    ])

    col_w = [3.8*cm, 2*cm, 2*cm, 1.5*cm, 2.8*cm, 2.8*cm, 2.8*cm]
    t = Table(rows, colWidths=col_w, repeatRows=1)
    extra = color_ganancia(rows, 6)
    ts = TableStyle(TABLE_HDR + extra + [
        ('BACKGROUND', (0,-1), (-1,-1), AZUL_CLARO),
        ('FONTNAME',   (0,-1), (-1,-1), 'Helvetica-Bold'),
        ('ALIGN',      (3,0),  (-1,-1), 'RIGHT'),
    ])
    t.setStyle(ts)
    story.append(t)
    story.append(Spacer(1, 0.3*cm))

    ganancias = sum(r['beneficio'] for r in ventas_acc if (r['beneficio'] or 0) > 0)
    perdidas  = sum(r['beneficio'] for r in ventas_acc if (r['beneficio'] or 0) < 0)
    story.append(Paragraph(
        f"<b>Resumen:</b> Ganancias <b>{eur(ganancias)}</b> · "
        f"Pérdidas <b>{eur(abs(perdidas))}</b> · "
        f"Resultado neto <b>{euro(total_benef)}</b>",
        S_RESUMEN))
    story.append(Paragraph(
        "Nota: Las pérdidas pueden compensarse con ganancias del mismo año y, si quedan saldo negativo, "
        "con el 25% de los rendimientos del capital mobiliario. El exceso se arrastra 4 años.",
        S_NOTA))
else:
    story.append(Paragraph(f"No se registraron ventas de acciones en {año}.", S_BODY))

story.append(Spacer(1, 0.5*cm))

# ── SECCIÓN 3: Ganancias/Pérdidas en ETFs ────────────────────────────────────
story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#cccccc'), spaceAfter=8))
story.append(Paragraph("3. Ganancias y Pérdidas Patrimoniales — ETFs y Fondos", S_H1))
story.append(Paragraph(
    "Los ETFs cotizan en bolsa y sus transmisiones tributan igual que las acciones: "
    "ganancia o pérdida patrimonial en la base del ahorro. "
    "A diferencia de los fondos de inversión, los ETFs NO permiten el traspaso sin peaje fiscal.",
    S_BODY))

if ventas_etf:
    total_coste   = sum(r['coste_total']      or 0 for r in ventas_etf)
    total_ingreso = sum(r['venta_neto']        or 0 for r in ventas_etf)
    total_gan     = sum(r['ganancia_sin_irpf'] or 0 for r in ventas_etf)

    hdr = ['ETF / Fondo', 'F. Venta', 'Coste compra', 'Ingreso venta', 'Comisión venta', 'Ganancia/Pérdida']
    rows = [hdr]
    for r in ventas_etf:
        rows.append([
            r['etf'],
            fdate(r['fecha_venta']),
            eur(r['coste_total']),
            eur(r['venta_neto']),
            eur(r['comision_venta']),
            euro(r['ganancia_sin_irpf']),
        ])
    rows.append([
        Paragraph('<b>TOTAL</b>', styles['Normal']),
        '',
        Paragraph(f'<b>{eur(total_coste)}</b>',   styles['Normal']),
        Paragraph(f'<b>{eur(total_ingreso)}</b>',  styles['Normal']),
        '',
        Paragraph(f'<b>{euro(total_gan)}</b>',     styles['Normal']),
    ])

    col_w = [5*cm, 2*cm, 3*cm, 3*cm, 2.5*cm, 3.2*cm]
    t = Table(rows, colWidths=col_w, repeatRows=1)
    extra = color_ganancia(rows, 5)
    ts = TableStyle(TABLE_HDR + extra + [
        ('BACKGROUND', (0,-1), (-1,-1), AZUL_CLARO),
        ('FONTNAME',   (0,-1), (-1,-1), 'Helvetica-Bold'),
        ('ALIGN',      (2,0),  (-1,-1), 'RIGHT'),
    ])
    t.setStyle(ts)
    story.append(t)
    story.append(Spacer(1, 0.3*cm))

    gan_etf = sum(r['ganancia_sin_irpf'] for r in ventas_etf if (r['ganancia_sin_irpf'] or 0) > 0)
    per_etf = sum(r['ganancia_sin_irpf'] for r in ventas_etf if (r['ganancia_sin_irpf'] or 0) < 0)
    story.append(Paragraph(
        f"<b>Resumen:</b> Ganancias <b>{eur(gan_etf)}</b> · "
        f"Pérdidas <b>{eur(abs(per_etf))}</b> · "
        f"Resultado neto <b>{euro(total_gan)}</b>",
        S_RESUMEN))
else:
    story.append(Paragraph(f"No se registraron ventas de ETFs/fondos en {año}.", S_BODY))

story.append(Spacer(1, 0.5*cm))

# ── SECCIÓN 4: Resumen Global ─────────────────────────────────────────────────
story.append(PageBreak())
story.append(Paragraph("4. Resumen Global del Ejercicio", S_H1))
story.append(HRFlowable(width="100%", thickness=1, color=AZUL, spaceAfter=10))

tot_div_bruto = sum(r['bruto']            or 0 for r in dividendos)
tot_div_ret   = sum(r['retencion']        or 0 for r in dividendos)
tot_acc_ben   = sum(r['beneficio']        or 0 for r in ventas_acc)
tot_etf_ben   = sum(r['ganancia_sin_irpf']or 0 for r in ventas_etf)
tot_gpat      = tot_acc_ben + tot_etf_ben

summary = [
    ['Concepto', 'Importe', 'Sección IRPF'],
    ['Dividendos (importe íntegro)',         eur(tot_div_bruto), 'Base del ahorro — Rendimientos capital mob.'],
    ['Retenciones sobre dividendos',         eur(tot_div_ret),   'Deducción en cuota íntegra'],
    ['G/P patrimonial acciones',             euro(tot_acc_ben),  'Base del ahorro — Ganancias patrimoniales'],
    ['G/P patrimonial ETFs/fondos',          euro(tot_etf_ben),  'Base del ahorro — Ganancias patrimoniales'],
    ['TOTAL ganancias patrimoniales netas',  euro(tot_gpat),     'Base del ahorro'],
]

col_w = [6*cm, 3.5*cm, 8.2*cm]
t = Table(summary, colWidths=col_w, repeatRows=1)
extra_sum = []
for i, row in enumerate(summary[1:], 1):
    try:
        val_str = row[1].replace('.','').replace(',','.').replace(' €','').replace('+','').strip()
        val = float(val_str)
        c = VERDE if val > 0 else (ROJO if val < 0 else NEGRO)
        extra_sum.append(('TEXTCOLOR', (1,i), (1,i), c))
        extra_sum.append(('FONTNAME',  (1,i), (1,i), 'Helvetica-Bold'))
    except: pass

ts = TableStyle(TABLE_HDR + extra_sum + [
    ('BACKGROUND', (0,-1), (-1,-1), AZUL_CLARO),
    ('FONTNAME',   (0,-1), (-1,-1), 'Helvetica-Bold'),
    ('ALIGN',      (1,0),  (1,-1),  'RIGHT'),
])
t.setStyle(ts)
story.append(t)
story.append(Spacer(1, 0.5*cm))

# Tipos impositivos base del ahorro
story.append(Paragraph("Tipos impositivos base del ahorro (referencia):", S_H2))
tipos = [
    ['Tramo', 'Tipo'],
    ['Hasta 6.000 €',              '19%'],
    ['De 6.000 € a 50.000 €',     '21%'],
    ['De 50.000 € a 200.000 €',   '23%'],
    ['De 200.000 € a 300.000 €',  '27%'],
    ['Más de 300.000 €',          '28%'],
]
t2 = Table(tipos, colWidths=[8*cm, 3*cm])
t2.setStyle(TableStyle(TABLE_HDR + [('ALIGN', (1,0), (1,-1), 'CENTER')]))
story.append(t2)

story.append(Spacer(1, 0.5*cm))
story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor('#cccccc'), spaceAfter=6))
story.append(Paragraph(
    "Este informe es orientativo y ha sido generado automáticamente a partir de los datos introducidos en Mi Patrimonio. "
    "Verifica los importes con los certificados fiscales de tu broker antes de presentar la declaración. "
    "Consulta con un asesor fiscal si tienes dudas.",
    S_NOTA))

# ── Build ────────────────────────────────────────────────────────────────────
doc.build(story)
print(f"OK:{OUTPDF}")
