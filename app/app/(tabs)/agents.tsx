import { View, Text, StyleSheet } from 'react-native'

export default function AgentsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.placeholder}>Agent Studio — Sprint 1</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a' },
  placeholder: { color: '#555555', fontSize: 16 },
})
