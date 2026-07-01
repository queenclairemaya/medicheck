# ================================================================
#  MediCheck — ML Micro-Service
#  ml_api.py  (place in your project root beside index.html)
#
#  Run with:  python ml_api.py
#  Listens on: http://localhost:5000/predict
#
#  Install deps first:
#    pip install flask flask-cors scikit-learn pandas joblib numpy
# ================================================================

from flask import Flask, request, jsonify
from flask_cors import CORS
import joblib
import pandas as pd
import numpy as np
import os

app = Flask(__name__)
CORS(app)  # Allow PHP on localhost to call this

# ── Load model and encoder ────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, 'medicheck_rf_model.pkl')
ENC_PATH   = os.path.join(BASE_DIR, 'medicheck_label_encoder.pkl')

try:
    model   = joblib.load(MODEL_PATH)
    encoder = joblib.load(ENC_PATH)
    print(f'✅  Model loaded from {MODEL_PATH}')
except FileNotFoundError as e:
    print(f'❌  Could not load model: {e}')
    print('    Run your notebook first to generate medicheck_rf_model.pkl')
    model   = None
    encoder = None

# ── Feature column order — must match training exactly ────────
FEATURE_COLS = [
    'scans_last_2h',
    'unique_locations_2h',
    'total_scans',
    'days_to_expiry',
    'is_blocked',
    'is_registered',
    'drug_category_enc',
    'manufacturer_reports',
    'batch_age_days',
]

# ── Category encoding — must match LabelEncoder from training ─
# Analgesic=0, Antibiotic=1, Antifungal=2, Antihypertensive=3,
# Antimalarial=4, Antiretroviral=5, Vitamin=6, Unknown=0
CATEGORY_MAP = {
    'analgesic':         0,
    'antibiotic':        1,
    'antifungal':        2,
    'antihypertensive':  3,
    'antimalarial':      4,
    'antiretroviral':    5,
    'vitamin':           6,
}

def encode_category(cat: str) -> int:
    """Map drug category string to integer, default 0 if unknown."""
    return CATEGORY_MAP.get((cat or '').strip().lower(), 0)


@app.route('/predict', methods=['POST'])
def predict():
    if model is None:
        return jsonify({'success': False, 'message': 'Model not loaded'}), 500

    data = request.get_json(force=True) or {}

    try:
        features = {
            'scans_last_2h':       int(data.get('scans_last_2h',       0)),
            'unique_locations_2h': int(data.get('unique_locations_2h', 1)),
            'total_scans':         int(data.get('total_scans',         0)),
            'days_to_expiry':      int(data.get('days_to_expiry',      0)),
            'is_blocked':          int(data.get('is_blocked',          0)),
            'is_registered':       int(data.get('is_registered',       1)),
            'drug_category_enc':   encode_category(data.get('drug_category', '')),
            'manufacturer_reports':int(data.get('manufacturer_reports',0)),
            'batch_age_days':      int(data.get('batch_age_days',      0)),
        }

        X   = pd.DataFrame([features], columns=FEATURE_COLS)
        pred   = model.predict(X)[0]
        proba  = model.predict_proba(X)[0]

        result     = 'genuine' if pred == 0 else 'suspect'
        confidence = round(float(max(proba)) * 100, 1)

        # Build signals for the frontend
        signals = []
        if pred == 1:
            if features['is_blocked']:
                signals.append({'type': 'red', 'text': 'Drug has been blocked by administrators'})
            if features['is_registered'] == 0:
                signals.append({'type': 'red', 'text': 'Drug ID not found in database'})
            if features['days_to_expiry'] < 0:
                signals.append({'type': 'red', 'text': 'Product has EXPIRED — do not use'})
            if features['scans_last_2h'] > 30 and features['unique_locations_2h'] >= 2:
                signals.append({'type': 'red', 'text': f"Scanned {features['scans_last_2h']}× in 2h across {features['unique_locations_2h']} locations"})
                signals.append({'type': 'red', 'text': 'Geographic anomaly detected'})
            elif features['scans_last_2h'] > 15:
                signals.append({'type': 'red', 'text': f"High scan frequency: {features['scans_last_2h']} scans in 2 hours"})
            if features['manufacturer_reports'] >= 5:
                signals.append({'type': 'red', 'text': f"Manufacturer has {features['manufacturer_reports']} fraud reports"})
            if not signals:
                signals.append({'type': 'red', 'text': 'ML model flagged this drug as suspicious'})
        else:
            signals.append({'type': 'green', 'text': 'Drug identity verified in database'})
            signals.append({'type': 'green', 'text': f"Total scans ({features['total_scans']}) within normal range"})
            signals.append({'type': 'green', 'text': 'No geographic anomaly detected'})
            signals.append({'type': 'green', 'text': 'Manufacturer identity confirmed'})

        return jsonify({
            'success':    True,
            'result':     result,
            'confidence': confidence,
            'signals':    signals,
            'features':   features,  # useful for debugging
        })

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 400


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model_loaded': model is not None})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', '0') == '1'
    app.run(host='0.0.0.0', port=port, debug=debug)
