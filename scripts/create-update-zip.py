#!/usr/bin/env python3
"""
Script per creare un archivio ZIP pulito per installazione o aggiornamento del DSV Tracking Center.
Include sorgenti, interfaccia web, script di sistema e test.
Esclude dati utente, sessioni browser, file di configurazione con segreti e node_modules.
"""

import os
import sys
import zipfile
from datetime import datetime

APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
os.chdir(APP_DIR)

TARGET_DATE = sys.argv[1] if len(sys.argv) > 1 else datetime.now().strftime("%Y-%m-%d")
ZIP_NAME = f"dsv-tracking-center-aggiornamento-pulito-{TARGET_DATE}.zip"
ZIP_PATH = os.path.join(APP_DIR, ZIP_NAME)

ROOT_FILES = [
    ".env.example",
    ".gitignore",
    "DEPLOY_PROXMOX.md",
    "DESIGN.md",
    "Dockerfile",
    "IMPORT-FIXES-DSV.md",
    "ISTRUZIONI_INSTALLAZIONE_AGGIORNAMENTO.md",
    "PRODUCT.md",
    "README.md",
    "docker-compose.yml",
    "package-lock.json",
    "package.json",
]

INCLUDE_DIRS = ["src", "public", "scripts", "tests"]


def get_files_to_pack():
    files = []
    for rf in ROOT_FILES:
        if os.path.isfile(rf):
            files.append(rf)
        else:
            print(f"ATTENZIONE: File radice mancante: {rf}", file=sys.stderr)

    for folder in INCLUDE_DIRS:
        for root, dirs, filenames in os.walk(folder):
            dirs.sort()
            for filename in sorted(filenames):
                # Escludi file temporanei o log
                if filename.endswith((".log", ".tmp", ".bak", ".swp")) or filename.startswith("."):
                    continue
                rel_path = os.path.relpath(os.path.join(root, filename), APP_DIR).replace("\\", "/")
                files.append(rel_path)
    return sorted(files)


def build_zip():
    files = get_files_to_pack()
    print(f"Creazione archivio pulito: {ZIP_NAME}")
    print(f"File totali da includere: {len(files)}")

    if os.path.exists(ZIP_PATH):
        os.remove(ZIP_PATH)

    with zipfile.ZipFile(ZIP_PATH, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for file_rel in files:
            file_abs = os.path.join(APP_DIR, file_rel.replace("/", os.sep))
            with open(file_abs, "rb") as f:
                data = f.read()

            # Normalizza percorsi zip con forward slash
            arcname = file_rel.replace("\\", "/")
            zip_info = zipfile.ZipInfo(arcname, date_time=datetime.now().timetuple()[:6])
            zip_info.compress_type = zipfile.ZIP_DEFLATED

            # Imposta permessi POSIX corretti
            is_executable = file_rel.endswith((".sh", ".initd"))
            mode = 0o755 if is_executable else 0o644
            zip_info.external_attr = (mode << 16) | 0o100000

            zf.writestr(zip_info, data)
            perm_str = "rwxr-xr-x" if is_executable else "rw-r--r--"
            print(f"  + [{perm_str}] {arcname}")

    # Verifica integrità
    print("\nVerifica integrità archivio...")
    with zipfile.ZipFile(ZIP_PATH, "r") as test_zf:
        bad_file = test_zf.testzip()
        if bad_file:
            print(f"ERRORE: File corrotto rilevato nell'archivio: {bad_file}", file=sys.stderr)
            sys.exit(1)
        entries_count = len(test_zf.infolist())

    size_kb = os.path.getsize(ZIP_PATH) / 1024
    print(f"\nArchivio creato con successo!")
    print(f"Nome file: {ZIP_NAME}")
    print(f"Dimensione: {size_kb:.1f} KB")
    print(f"Totale elementi: {entries_count}")


if __name__ == "__main__":
    build_zip()
