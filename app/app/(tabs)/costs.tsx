import { View, Text, StyleSheet } from 'react-native'

export default function CostsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.placeholder}>Cost Centre — Sprint 3</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a' },
  placeholder: { color: '#555555', fontSize: 16 },
})
