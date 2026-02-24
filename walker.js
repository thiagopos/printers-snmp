import snmp from 'net-snmp';
import fs from 'fs';

const TARGET_IP = "192.168.49.20";
const COMMUNITY  = "public";
const OUTPUT_CSV = "output.csv";

// OID raiz — vai andar por tudo a partir daqui
const ROOT_OID = "1.3.6.1";

const session = snmp.createSession(TARGET_IP, COMMUNITY, {
  timeout: 5000,
  retries: 1,
  version: snmp.Version2c,
});

const rows = [["oid", "type", "value"]];
let count = 0;

console.log(`Iniciando SNMP walk em ${TARGET_IP} a partir de ${ROOT_OID}...`);

session.walk(ROOT_OID, 20, (varbinds) => {
  for (const vb of varbinds) {
    if (snmp.isVarbindError(vb)) {
      console.warn(`  Erro em ${vb.oid}: ${snmp.varbindError(vb)}`);
      continue;
    }
    const type  = snmp.ObjectType[vb.type] ?? vb.type;
    const value = vb.value?.toString() ?? "";
    rows.push([vb.oid, type, `"${value.replace(/"/g, '""')}"`]);
    count++;
    process.stdout.write(`\r  ${count} OIDs coletados...`);
  }
}, (err) => {
  session.close();

  if (err) {
    console.error("\nErro durante o walk:", err.toString());
    process.exit(1);
  }

  console.log(`\nWalk concluído. ${count} OIDs encontrados.`);

  const csv = rows.map(r => r.join(",")).join("\n");
  fs.writeFileSync(OUTPUT_CSV, csv, "utf-8");
  console.log(`Salvo em ${OUTPUT_CSV}`);
});


