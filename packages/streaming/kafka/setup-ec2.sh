#!/usr/bin/env bash
set -euo pipefail

# Run on the Kafka EC2 instance after installing Java and unpacking Kafka 3.9.1.
: "${KAFKA_HOME:?Set KAFKA_HOME to the Kafka installation directory}"
: "${PRIVATE_IP:?Set PRIVATE_IP to this EC2 instance's private IPv4 address}"

install -d /var/lib/kafka/data
sed "s/__PRIVATE_IP__/${PRIVATE_IP}/g" "$(dirname "$0")/server.properties.example" \
  > "${KAFKA_HOME}/config/razzia-server.properties"

cluster_id="$("${KAFKA_HOME}/bin/kafka-storage.sh" random-uuid)"
"${KAFKA_HOME}/bin/kafka-storage.sh" format --standalone \
  -t "${cluster_id}" -c "${KAFKA_HOME}/config/razzia-server.properties"

echo "KRaft storage formatted. Start the broker with:"
echo "${KAFKA_HOME}/bin/kafka-server-start.sh ${KAFKA_HOME}/config/razzia-server.properties"
echo "Then run the create-topic script from a host that can reach ${PRIVATE_IP}:9092."
