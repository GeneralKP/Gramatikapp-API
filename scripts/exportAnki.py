"""Read an APKG as data; never render or execute note HTML or templates."""
import argparse
import base64
import hashlib
import json
import pathlib
import sqlite3
import subprocess
import zipfile


def export(source, output):
    source, output = pathlib.Path(source).resolve(), pathlib.Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    output.chmod(0o700)
    with zipfile.ZipFile(source) as archive:
        names = archive.namelist()
        name = next((n for n in ["collection.anki21b", "collection.anki21", "collection.anki2"] if n in names), None)
        if not name:
            raise ValueError("No Anki collection found")
        content = archive.read(name)
        if name.endswith("21b"):
            content = subprocess.run(["node", "--input-type=module", "-e",
                "import{zstdDecompressSync}from'node:zlib';let b=[];for await(const c of process.stdin)b.push(c);process.stdout.write(zstdDecompressSync(Buffer.concat(b)));"],
                input=content, capture_output=True, check=True).stdout
        (output / "collection.sqlite").write_bytes(content)
        (output / "collection.sqlite").chmod(0o600)
        media_entries = [n for n in names if n.isdigit()]
        if media_entries:
            raise ValueError("This importer requires text-only decks; media is not silently discarded")
    db = sqlite3.connect((output / "collection.sqlite").as_uri() + "?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    db.create_collation("unicase", lambda a, b: (a.casefold() > b.casefold()) - (a.casefold() < b.casefold()))
    def rows(table):
        return [{k: {"base64": base64.b64encode(v).decode()} if isinstance(v, bytes) else v
                 for k, v in dict(row).items()} for row in db.execute('SELECT * FROM "' + table + '"')]
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    payload = {"sourceHash": hashlib.sha256(source.read_bytes()).hexdigest(), "sourceName": source.name,
               "tables": {table: rows(table) for table in ["col", "notes", "cards", "revlog", "fields", "templates", "notetypes", "decks", "deck_config", "config", "tags", "graves"] if table in tables}}
    db.close()
    (output / "export.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    (output / "export.json").chmod(0o600)
    print(json.dumps({"export": str(output / "export.json"), "notes": len(payload["tables"]["notes"]),
                      "cards": len(payload["tables"]["cards"]), "reviews": len(payload["tables"]["revlog"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    export(args.source, args.output)
